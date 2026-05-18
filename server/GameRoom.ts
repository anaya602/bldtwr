/**
 * server/GameRoom.ts
 *
 * Colyseus Room — one instance per active game session.
 *
 * Pitfall-proof:
 * - Physics runs in setSimulationInterval (Colyseus-managed, not setInterval)
 *   so it pauses cleanly during room dispose.
 * - All client messages validated (type, phase guard, ownership guard).
 * - Chat sanitised server-side: HTML-entity-encode, length cap, rate-limit.
 * - Reconnect: allowReconnection(30s) + sessionStorage token on client.
 * - Host-leave: promote next oldest connected player, broadcast host_changed.
 * - Solo room (last player): dispose gracefully (don't crash).
 * - Idempotent drop: DROPPING phase gate prevents double-drop.
 * - Block out-of-bounds: ALL coordinate clamping happens in PhysicsEngine.spawnBlock.
 * - seqId dedup: last-32-seen ring buffer per client.
 */

import { Room, Client } from "colyseus";
import type { RoomOptions } from "@colyseus/core";
import { RoomState, PlayerState, BlockState } from "./schema/RoomState";
import { PhysicsEngine } from "./PhysicsEngine";
import { RoundManager } from "./RoundManager";
import { ScoreTracker } from "./ScoreTracker";
import {
  CLIENT_MSGS,
  SERVER_EVENTS,
  PHASES,
  BLOCK_SIZES,
  CHAT_MAX_LENGTH,
  CHAT_RATE_LIMIT_PER_S,
  RECONNECT_TIMEOUT_S,
  MOVE_STEP_UNITS,
  FIELD_HALF_WIDTH_UNITS,
  DEFAULT_BLOCK_SIZE_INDEX,
  clamp,
} from "../shared/constants";
import { ArraySchema } from "@colyseus/schema";

// ─── Chat rate limiter per client ────────────────────────────────────────────
interface RateBucket {
  tokens: number;
  lastRefill: number;
}

// ─── Seen-seqId ring buffer (idempotency) ───────────────────────────────────
const SEQ_HISTORY_SIZE = 32;

function htmlEncode(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/1/0 ambiguity
  return Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

type BlindTowerOptions = RoomOptions & { state?: RoomState };

export class GameRoom extends Room<BlindTowerOptions> {
  maxClients = 12;

  private physics!: PhysicsEngine;
  private roundManager!: RoundManager;
  private scoreTracker!: ScoreTracker;

  /** Active block ID currently in PLACING phase (one at a time). */
  private activeBlockId: string | null = null;

  /** Per-client rate limiters for chat. */
  private chatBuckets = new Map<string, RateBucket>();

  /** Per-client seen seqIds (ring buffer for dedup). */
  private seenSeqs = new Map<string, string[]>();

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  onCreate(options: Record<string, unknown>): void {
    // Initialize state
    const state = new RoomState();
    // If a specific roomCode was requested (shouldn't happen on create, but guard it)
    state.roomCode = (typeof options.roomCode === "string" && options.roomCode.length === 4)
      ? options.roomCode.toUpperCase()
      : generateRoomCode();
    this.setState(state);

    // Expose roomCode as filterable metadata so joinOrCreate({ roomCode }) routes correctly
    this.setMetadata({ roomCode: state.roomCode });

    // Sub-systems
    this.physics = new PhysicsEngine();
    this.scoreTracker = new ScoreTracker();
    this.roundManager = new RoundManager(
      state,
      (event, data) => this.broadcast(event, data)
    );

    // Register message handlers
    this._registerMessages();

    // Physics tick at 30 Hz via Colyseus simulation interval
    this.setSimulationInterval(
      (deltaMs) => this._physicsTick(deltaMs),
      1000 / 30
    );

    console.log(`[GameRoom] Created room ${state.roomCode}`);
  }

  async onJoin(client: Client, options: { displayName?: string }): Promise<void> {
    const state = this.state as RoomState;
    const isFirstPlayer = state.players.size === 0;

    const player = new PlayerState();
    player.id = client.sessionId;
    player.displayName = htmlEncode(
      (options.displayName || "Player").slice(0, 20)
    );
    player.isHost = isFirstPlayer;
    player.isConnected = true;
    player.role = "builder";
    player.score = 0;
    player.blindCount = 0;

    if (isFirstPlayer) {
      state.hostId = client.sessionId;
    }

    state.players.set(client.sessionId, player);
    this.chatBuckets.set(client.sessionId, {
      tokens: CHAT_RATE_LIMIT_PER_S,
      lastRefill: Date.now(),
    });
    this.seenSeqs.set(client.sessionId, []);

    // Send the room code directly to the joining client
    client.send("room_info", { roomCode: state.roomCode });

    console.log(`[GameRoom] ${player.displayName} joined (${client.sessionId})`);
  }

  onLeave(client: Client, code?: number): void | Promise<void> {
    // code === 1000 = clean close (consented). Any other code = unintentional.
    const consented = code === 1000;
    const state = this.state as RoomState;
    const player = state.players.get(client.sessionId);
    if (!player) return;

    console.log(`[GameRoom] ${player.displayName} left (consented=${consented})`);

    if (!consented && state.phase !== PHASES.LOBBY && state.phase !== PHASES.ENDED) {
      // Unintentional disconnect — allow reconnection for 30 s
      player.isConnected = false;
      return this.allowReconnection(client, RECONNECT_TIMEOUT_S).then(
        (reconnectedClient) => {
          player.isConnected = true;
          reconnectedClient.send("room_info", { roomCode: state.roomCode });
          console.log(`[GameRoom] ${player.displayName} reconnected`);
        },
        () => {
          // Reconnect window expired
          console.log(`[GameRoom] ${player.displayName} reconnect timed out`);
          this._handleFinalLeave(client.sessionId);
        }
      );
    } else {
      this._handleFinalLeave(client.sessionId);
    }
  }

  onDispose(): void {
    this.physics.dispose();
    this.roundManager.dispose();
    console.log(`[GameRoom] Disposed`);
  }

  // ─── Message handlers ──────────────────────────────────────────────────────

  private _registerMessages(): void {
    const state = this.state as RoomState;

    // Host: start game
    this.onMessage(CLIENT_MSGS.START_GAME, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      const err = this.roundManager.startGame(client.sessionId);
      if (err) client.send(SERVER_EVENTS.ERROR, { message: err });
    });

    // Host: end game
    this.onMessage(CLIENT_MSGS.END_GAME, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      const err = this.roundManager.endGame(client.sessionId);
      if (err) client.send(SERVER_EVENTS.ERROR, { message: err });
    });

    // Blind player: move left
    this.onMessage(CLIENT_MSGS.MOVE_LEFT, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      if (!this._isBlindPlayerTurn(client.sessionId)) return;
      if (state.phase !== PHASES.PLACING) return;

      state.heldBlockX = clamp(
        state.heldBlockX - MOVE_STEP_UNITS,
        -FIELD_HALF_WIDTH_UNITS,
        FIELD_HALF_WIDTH_UNITS
      );
    });

    // Blind player: move right
    this.onMessage(CLIENT_MSGS.MOVE_RIGHT, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      if (!this._isBlindPlayerTurn(client.sessionId)) return;
      if (state.phase !== PHASES.PLACING) return;

      state.heldBlockX = clamp(
        state.heldBlockX + MOVE_STEP_UNITS,
        -FIELD_HALF_WIDTH_UNITS,
        FIELD_HALF_WIDTH_UNITS
      );
    });

    // Blind player: cycle size up
    this.onMessage(CLIENT_MSGS.SIZE_UP, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      if (!this._isBlindPlayerTurn(client.sessionId)) return;
      if (state.phase !== PHASES.PLACING) return;

      state.currentSizeIndex = clamp(
        state.currentSizeIndex + 1,
        0,
        BLOCK_SIZES.length - 1
      );
    });

    // Blind player: cycle size down
    this.onMessage(CLIENT_MSGS.SIZE_DOWN, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      if (!this._isBlindPlayerTurn(client.sessionId)) return;
      if (state.phase !== PHASES.PLACING) return;

      state.currentSizeIndex = clamp(
        state.currentSizeIndex - 1,
        0,
        BLOCK_SIZES.length - 1
      );
    });

    // Blind player: drop block
    this.onMessage(CLIENT_MSGS.DROP, (client, msg) => {
      if (!this._dedup(client.sessionId, msg?.seqId)) return;
      if (!this._isBlindPlayerTurn(client.sessionId)) return;
      if (state.phase !== PHASES.PLACING) return;

      this._handleDrop(client.sessionId);
    });

    // Chat (all players)
    this.onMessage(CLIENT_MSGS.CHAT, (client, msg) => {
      this._handleChat(client, msg);
    });
  }

  // ─── Drop logic ────────────────────────────────────────────────────────────

  private _handleDrop(sessionId: string): void {
    const state = this.state as RoomState;

    // Transition phase first (guards against duplicate drops)
    this.roundManager.onDrop();

    // Spawn the authoritative block in physics world
    const blockId = this.physics.spawnBlock(
      state.heldBlockX,
      state.currentSizeIndex,
      sessionId
    );
    this.activeBlockId = blockId;

    // Create the schema block entry (will be updated each physics tick)
    const blockState = new BlockState();
    blockState.id = blockId;
    blockState.ownerId = sessionId;
    blockState.isHeld = false;
    blockState.isSettled = false;

    const physicsBlocks = this.physics.getAllBlocks();
    const body = physicsBlocks.get(blockId)?.body;
    if (body) {
      blockState.x = body.position.x;
      blockState.y = body.position.y;
      blockState.angle = body.angle;
      const size = BLOCK_SIZES[state.currentSizeIndex];
      blockState.w = size.w * 40; // UNIT
      blockState.h = size.h * 40;
    }

    if (!state.blocks) {
      (state as any).blocks = new ArraySchema<BlockState>();
    }
    state.blocks.push(blockState);
  }

  // ─── Physics tick ──────────────────────────────────────────────────────────

  private _physicsTick(_deltaMs: number): void {
    const state = this.state as RoomState;

    // Only run physics during DROPPING phase
    if (state.phase !== PHASES.DROPPING) return;

    const { updates, newlySettled } = this.physics.step();

    // Write physics results back to schema (triggers delta patch to clients)
    for (const update of updates) {
      const schemaBlock = state.blocks.find((b) => b.id === update.id);
      if (!schemaBlock) continue;
      schemaBlock.x = update.x;
      schemaBlock.y = update.y;
      schemaBlock.angle = update.angle;
      schemaBlock.isSettled = update.isSettled;
    }

    // Check if the active block just settled
    if (
      this.activeBlockId &&
      newlySettled.includes(this.activeBlockId)
    ) {
      this._onBlockSettled();
    }
  }

  private _onBlockSettled(): void {
    const state = this.state as RoomState;
    const result = this.scoreTracker.computeHeight(this.physics);
    const score = this.scoreTracker.toScore(result);

    // Add this round's score to the blind player's cumulative score
    const blindPlayer = state.players.get(state.currentBlindId);
    if (blindPlayer) {
      blindPlayer.score += score;
    }

    this.activeBlockId = null;
    this.roundManager.onAllSettled(result.heightUnits, score);
  }

  // ─── Chat ──────────────────────────────────────────────────────────────────

  private _handleChat(client: Client, msg: unknown): void {
    const state = this.state as RoomState;
    const player = state.players.get(client.sessionId);
    if (!player || !player.isConnected) return;

    // Rate limit: token bucket
    const bucket = this.chatBuckets.get(client.sessionId);
    if (!bucket) return;
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      CHAT_RATE_LIMIT_PER_S,
      bucket.tokens + elapsed * CHAT_RATE_LIMIT_PER_S
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return; // rate limited
    bucket.tokens -= 1;

    // Extract and sanitize message text
    const raw =
      typeof (msg as any)?.text === "string"
        ? (msg as any).text
        : typeof msg === "string"
        ? msg
        : "";

    const sanitized = htmlEncode(raw.slice(0, CHAT_MAX_LENGTH).trim());
    if (!sanitized) return;

    this.broadcast(SERVER_EVENTS.CHAT_MSG, {
      senderId: client.sessionId,
      senderName: player.displayName,
      text: sanitized,
      timestamp: now,
    });
  }

  // ─── Player management ─────────────────────────────────────────────────────

  private _handleFinalLeave(sessionId: string): void {
    const state = this.state as RoomState;
    const wasHost = state.hostId === sessionId;

    state.players.delete(sessionId);
    this.chatBuckets.delete(sessionId);
    this.seenSeqs.delete(sessionId);

    if (state.players.size === 0) return; // room will auto-dispose

    if (wasHost) {
      // Promote the next oldest connected player
      const remaining = Array.from(state.players.values()).filter(
        (p) => p.isConnected
      );
      if (remaining.length > 0) {
        const newHost = remaining[0];
        newHost.isHost = true;
        state.hostId = newHost.id;
        this.broadcast(SERVER_EVENTS.HOST_CHANGED, {
          newHostId: newHost.id,
          newHostName: newHost.displayName,
        });
      }
    }

    // If the blind player left mid-round, skip to scoring
    if (
      sessionId === state.currentBlindId &&
      (state.phase === PHASES.PLACING || state.phase === PHASES.DROPPING)
    ) {
      const result = this.scoreTracker.computeHeight(this.physics);
      this.roundManager.onAllSettled(result.heightUnits, this.scoreTracker.toScore(result));
    }
  }

  // ─── Guards & utilities ────────────────────────────────────────────────────

  private _isBlindPlayerTurn(sessionId: string): boolean {
    return (this.state as RoomState).currentBlindId === sessionId;
  }

  /**
   * Idempotency dedup: returns true if this seqId is NEW (should process).
   * Maintains a ring buffer of last SEQ_HISTORY_SIZE seqIds per client.
   *
   * Pitfall: if seqId is absent (undefined/null), always process (not all
   * messages require dedup — e.g. chat is idempotent by nature).
   */
  private _dedup(sessionId: string, seqId: unknown): boolean {
    if (seqId === undefined || seqId === null) return true;
    const id = String(seqId);
    const seen = this.seenSeqs.get(sessionId) ?? [];

    if (seen.includes(id)) return false; // duplicate

    seen.push(id);
    if (seen.length > SEQ_HISTORY_SIZE) seen.shift(); // ring: drop oldest
    this.seenSeqs.set(sessionId, seen);
    return true;
  }
}
