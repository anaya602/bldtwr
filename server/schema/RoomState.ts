/**
 * server/schema/RoomState.ts
 *
 * Colyseus @colyseus/schema definitions.
 * WHY: Schema enables automatic binary delta patches — only CHANGED fields
 * cross the wire each tick (~33 ms). Full JSON state would be ~10x larger.
 *
 * Pitfall-proof:
 * - All fields typed explicitly (no `any`) — schema encoder needs types.
 * - ArraySchema/MapSchema used for collections (plain arrays break delta).
 * - No methods on schema classes — keep them as pure data containers.
 */

import {
  Schema,
  type,
  ArraySchema,
  MapSchema,
} from "@colyseus/schema";
import { Phase, PHASES } from "../../shared/constants";

// ─── BlockState ───────────────────────────────────────────────────────────────
export class BlockState extends Schema {
  @type("string")  id: string = "";

  /** World X in pixels (Matter.js coords, origin = center of ground). */
  @type("float32") x: number = 0;

  /** World Y in pixels (Matter.js coords, positive = downward). */
  @type("float32") y: number = 0;

  /** Rotation in radians. */
  @type("float32") angle: number = 0;

  /** Width in pixels. */
  @type("float32") w: number = 0;

  /** Height in pixels. */
  @type("float32") h: number = 0;

  /** SessionId of the player who dropped this block. */
  @type("string")  ownerId: string = "";

  /**
   * True once the block has come to rest.
   * Client uses this to stop lerping and lock position.
   * ScoreTracker only reads settled blocks.
   */
  @type("boolean") isSettled: boolean = false;

  /**
   * True while the blind player is still positioning (pre-drop).
   * Client renders a ghost outline in this state.
   */
  @type("boolean") isHeld: boolean = true;
}

// ─── PlayerState ──────────────────────────────────────────────────────────────
export class PlayerState extends Schema {
  @type("string")  id: string = "";          // Colyseus sessionId
  @type("string")  displayName: string = "";

  /**
   * "host" | "blind" | "builder" | "spectator"
   * Not using an enum so new roles can be added without schema migration.
   */
  @type("string")  role: string = "builder";

  @type("boolean") isConnected: boolean = true;
  @type("boolean") isHost: boolean = false;

  /** Running total score (sum of stable tower heights this session). */
  @type("float32") score: number = 0;

  /** How many times this player has been the blind player. */
  @type("int32")   blindCount: number = 0;
}

// ─── RoomState (root) ─────────────────────────────────────────────────────────
export class RoomState extends Schema {
  /**
   * Phase FSM string. Clients switch scene overlays based on this.
   * Using string (not int) so logs are human-readable.
   */
  @type("string")  phase: Phase = PHASES.LOBBY;

  @type("int32")   roundNumber: number = 0;

  /**
   * SessionId of the current blind player.
   * Empty string = nobody blind yet (lobby or between rounds).
   */
  @type("string")  currentBlindId: string = "";

  /**
   * SessionId of the host.
   * Separate from players[x].isHost so clients can identify host quickly.
   */
  @type("string")  hostId: string = "";

  /**
   * All players keyed by sessionId.
   * MapSchema gives O(1) lookup and delta-patches individual entries.
   */
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();

  /**
   * All blocks in the current round, in spawn order.
   * ArraySchema patches only changed indices.
   *
   * Pitfall: we never reuse indices mid-round — only append.
   * Clearing and rebuilding the array each round is fine (full patch).
   */
  @type([BlockState]) blocks = new ArraySchema<BlockState>();

  /**
   * Index into BLOCK_SIZES for the currently held (pre-drop) block.
   * Stored in state so all clients see the blind player's current size choice.
   */
  @type("int32")   currentSizeIndex: number = 1;

  /**
   * X position (in game units, ±11) of the block being held.
   * Stored so non-blind clients see the ghost block moving.
   */
  @type("float32") heldBlockX: number = 0;

  /**
   * Informational: last round's tower height (for score flash UI).
   */
  @type("float32") lastRoundHeight: number = 0;

  /**
   * Room join code (4-char uppercase). Set once on room creation.
   * Clients display this in the lobby for others to join.
   */
  @type("string")  roomCode: string = "";
}
