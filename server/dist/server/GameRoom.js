"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GameRoom = void 0;
const colyseus_1 = require("colyseus");
const RoomState_1 = require("./schema/RoomState");
const PhysicsEngine_1 = require("./PhysicsEngine");
const RoundManager_1 = require("./RoundManager");
const ScoreTracker_1 = require("./ScoreTracker");
const constants_1 = require("../shared/constants");
const schema_1 = require("@colyseus/schema");
// ─── Seen-seqId ring buffer (idempotency) ───────────────────────────────────
const SEQ_HISTORY_SIZE = 32;
function htmlEncode(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/1/0 ambiguity
    return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
class GameRoom extends colyseus_1.Room {
    constructor() {
        super(...arguments);
        this.maxClients = 12;
        /** Active block ID currently in PLACING phase (one at a time). */
        this.activeBlockId = null;
        /** Per-client rate limiters for chat. */
        this.chatBuckets = new Map();
        /** Per-client seen seqIds (ring buffer for dedup). */
        this.seenSeqs = new Map();
    }
    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    onCreate(options) {
        // Initialize state
        const state = new RoomState_1.RoomState();
        // If a specific roomCode was requested (shouldn't happen on create, but guard it)
        state.roomCode = (typeof options.roomCode === "string" && options.roomCode.length === 4)
            ? options.roomCode.toUpperCase()
            : generateRoomCode();
        this.setState(state);
        // Expose roomCode as filterable metadata so joinOrCreate({ roomCode }) routes correctly
        this.setMetadata({ roomCode: state.roomCode });
        // Sub-systems
        this.physics = new PhysicsEngine_1.PhysicsEngine();
        this.scoreTracker = new ScoreTracker_1.ScoreTracker();
        this.roundManager = new RoundManager_1.RoundManager(state, (event, data) => this.broadcast(event, data));
        // Register message handlers
        this._registerMessages();
        // Physics tick at 30 Hz via Colyseus simulation interval
        this.setSimulationInterval((deltaMs) => this._physicsTick(deltaMs), 1000 / 30);
        console.log(`[GameRoom] Created room ${state.roomCode}`);
    }
    async onJoin(client, options) {
        const state = this.state;
        const isFirstPlayer = state.players.size === 0;
        const player = new RoomState_1.PlayerState();
        player.id = client.sessionId;
        player.displayName = htmlEncode((options.displayName || "Player").slice(0, 20));
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
            tokens: constants_1.CHAT_RATE_LIMIT_PER_S,
            lastRefill: Date.now(),
        });
        this.seenSeqs.set(client.sessionId, []);
        // Send the room code directly to the joining client
        client.send("room_info", { roomCode: state.roomCode });
        console.log(`[GameRoom] ${player.displayName} joined (${client.sessionId})`);
    }
    onLeave(client, code) {
        // code === 1000 = clean close (consented). Any other code = unintentional.
        const consented = code === 1000;
        const state = this.state;
        const player = state.players.get(client.sessionId);
        if (!player)
            return;
        console.log(`[GameRoom] ${player.displayName} left (consented=${consented})`);
        if (!consented && state.phase !== constants_1.PHASES.LOBBY && state.phase !== constants_1.PHASES.ENDED) {
            // Unintentional disconnect — allow reconnection for 30 s
            player.isConnected = false;
            return this.allowReconnection(client, constants_1.RECONNECT_TIMEOUT_S).then((reconnectedClient) => {
                player.isConnected = true;
                reconnectedClient.send("room_info", { roomCode: state.roomCode });
                console.log(`[GameRoom] ${player.displayName} reconnected`);
            }, () => {
                // Reconnect window expired
                console.log(`[GameRoom] ${player.displayName} reconnect timed out`);
                this._handleFinalLeave(client.sessionId);
            });
        }
        else {
            this._handleFinalLeave(client.sessionId);
        }
    }
    onDispose() {
        this.physics.dispose();
        this.roundManager.dispose();
        console.log(`[GameRoom] Disposed`);
    }
    // ─── Message handlers ──────────────────────────────────────────────────────
    _registerMessages() {
        const state = this.state;
        // Host: start game
        this.onMessage(constants_1.CLIENT_MSGS.START_GAME, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            const err = this.roundManager.startGame(client.sessionId);
            if (err)
                client.send(constants_1.SERVER_EVENTS.ERROR, { message: err });
        });
        // Host: end game
        this.onMessage(constants_1.CLIENT_MSGS.END_GAME, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            const err = this.roundManager.endGame(client.sessionId);
            if (err)
                client.send(constants_1.SERVER_EVENTS.ERROR, { message: err });
        });
        // Blind player: move left
        this.onMessage(constants_1.CLIENT_MSGS.MOVE_LEFT, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            if (!this._isBlindPlayerTurn(client.sessionId))
                return;
            if (state.phase !== constants_1.PHASES.PLACING)
                return;
            state.heldBlockX = (0, constants_1.clamp)(state.heldBlockX - constants_1.MOVE_STEP_UNITS, -constants_1.FIELD_HALF_WIDTH_UNITS, constants_1.FIELD_HALF_WIDTH_UNITS);
        });
        // Blind player: move right
        this.onMessage(constants_1.CLIENT_MSGS.MOVE_RIGHT, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            if (!this._isBlindPlayerTurn(client.sessionId))
                return;
            if (state.phase !== constants_1.PHASES.PLACING)
                return;
            state.heldBlockX = (0, constants_1.clamp)(state.heldBlockX + constants_1.MOVE_STEP_UNITS, -constants_1.FIELD_HALF_WIDTH_UNITS, constants_1.FIELD_HALF_WIDTH_UNITS);
        });
        // Blind player: cycle size up
        this.onMessage(constants_1.CLIENT_MSGS.SIZE_UP, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            if (!this._isBlindPlayerTurn(client.sessionId))
                return;
            if (state.phase !== constants_1.PHASES.PLACING)
                return;
            state.currentSizeIndex = (0, constants_1.clamp)(state.currentSizeIndex + 1, 0, constants_1.BLOCK_SIZES.length - 1);
        });
        // Blind player: cycle size down
        this.onMessage(constants_1.CLIENT_MSGS.SIZE_DOWN, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            if (!this._isBlindPlayerTurn(client.sessionId))
                return;
            if (state.phase !== constants_1.PHASES.PLACING)
                return;
            state.currentSizeIndex = (0, constants_1.clamp)(state.currentSizeIndex - 1, 0, constants_1.BLOCK_SIZES.length - 1);
        });
        // Blind player: drop block
        this.onMessage(constants_1.CLIENT_MSGS.DROP, (client, msg) => {
            if (!this._dedup(client.sessionId, msg?.seqId))
                return;
            if (!this._isBlindPlayerTurn(client.sessionId))
                return;
            if (state.phase !== constants_1.PHASES.PLACING)
                return;
            this._handleDrop(client.sessionId);
        });
        // Chat (all players)
        this.onMessage(constants_1.CLIENT_MSGS.CHAT, (client, msg) => {
            this._handleChat(client, msg);
        });
    }
    // ─── Drop logic ────────────────────────────────────────────────────────────
    _handleDrop(sessionId) {
        const state = this.state;
        // Transition phase first (guards against duplicate drops)
        this.roundManager.onDrop();
        // Spawn the authoritative block in physics world
        const blockId = this.physics.spawnBlock(state.heldBlockX, state.currentSizeIndex, sessionId);
        this.activeBlockId = blockId;
        // Create the schema block entry (will be updated each physics tick)
        const blockState = new RoomState_1.BlockState();
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
            const size = constants_1.BLOCK_SIZES[state.currentSizeIndex];
            blockState.w = size.w * 40; // UNIT
            blockState.h = size.h * 40;
        }
        if (!state.blocks) {
            state.blocks = new schema_1.ArraySchema();
        }
        state.blocks.push(blockState);
    }
    // ─── Physics tick ──────────────────────────────────────────────────────────
    _physicsTick(_deltaMs) {
        const state = this.state;
        // Only run physics during DROPPING phase
        if (state.phase !== constants_1.PHASES.DROPPING)
            return;
        const { updates, newlySettled } = this.physics.step();
        // Write physics results back to schema (triggers delta patch to clients)
        for (const update of updates) {
            const schemaBlock = state.blocks.find((b) => b.id === update.id);
            if (!schemaBlock)
                continue;
            schemaBlock.x = update.x;
            schemaBlock.y = update.y;
            schemaBlock.angle = update.angle;
            schemaBlock.isSettled = update.isSettled;
        }
        // Check if the active block just settled
        if (this.activeBlockId &&
            newlySettled.includes(this.activeBlockId)) {
            this._onBlockSettled();
        }
    }
    _onBlockSettled() {
        const state = this.state;
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
    _handleChat(client, msg) {
        const state = this.state;
        const player = state.players.get(client.sessionId);
        if (!player || !player.isConnected)
            return;
        // Rate limit: token bucket
        const bucket = this.chatBuckets.get(client.sessionId);
        if (!bucket)
            return;
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(constants_1.CHAT_RATE_LIMIT_PER_S, bucket.tokens + elapsed * constants_1.CHAT_RATE_LIMIT_PER_S);
        bucket.lastRefill = now;
        if (bucket.tokens < 1)
            return; // rate limited
        bucket.tokens -= 1;
        // Extract and sanitize message text
        const raw = typeof msg?.text === "string"
            ? msg.text
            : typeof msg === "string"
                ? msg
                : "";
        const sanitized = htmlEncode(raw.slice(0, constants_1.CHAT_MAX_LENGTH).trim());
        if (!sanitized)
            return;
        this.broadcast(constants_1.SERVER_EVENTS.CHAT_MSG, {
            senderId: client.sessionId,
            senderName: player.displayName,
            text: sanitized,
            timestamp: now,
        });
    }
    // ─── Player management ─────────────────────────────────────────────────────
    _handleFinalLeave(sessionId) {
        const state = this.state;
        const wasHost = state.hostId === sessionId;
        state.players.delete(sessionId);
        this.chatBuckets.delete(sessionId);
        this.seenSeqs.delete(sessionId);
        if (state.players.size === 0)
            return; // room will auto-dispose
        if (wasHost) {
            // Promote the next oldest connected player
            const remaining = Array.from(state.players.values()).filter((p) => p.isConnected);
            if (remaining.length > 0) {
                const newHost = remaining[0];
                newHost.isHost = true;
                state.hostId = newHost.id;
                this.broadcast(constants_1.SERVER_EVENTS.HOST_CHANGED, {
                    newHostId: newHost.id,
                    newHostName: newHost.displayName,
                });
            }
        }
        // If the blind player left mid-round, skip to scoring
        if (sessionId === state.currentBlindId &&
            (state.phase === constants_1.PHASES.PLACING || state.phase === constants_1.PHASES.DROPPING)) {
            const result = this.scoreTracker.computeHeight(this.physics);
            this.roundManager.onAllSettled(result.heightUnits, this.scoreTracker.toScore(result));
        }
    }
    // ─── Guards & utilities ────────────────────────────────────────────────────
    _isBlindPlayerTurn(sessionId) {
        return this.state.currentBlindId === sessionId;
    }
    /**
     * Idempotency dedup: returns true if this seqId is NEW (should process).
     * Maintains a ring buffer of last SEQ_HISTORY_SIZE seqIds per client.
     *
     * Pitfall: if seqId is absent (undefined/null), always process (not all
     * messages require dedup — e.g. chat is idempotent by nature).
     */
    _dedup(sessionId, seqId) {
        if (seqId === undefined || seqId === null)
            return true;
        const id = String(seqId);
        const seen = this.seenSeqs.get(sessionId) ?? [];
        if (seen.includes(id))
            return false; // duplicate
        seen.push(id);
        if (seen.length > SEQ_HISTORY_SIZE)
            seen.shift(); // ring: drop oldest
        this.seenSeqs.set(sessionId, seen);
        return true;
    }
}
exports.GameRoom = GameRoom;
