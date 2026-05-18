/**
 * shared/constants.ts
 * Single source of truth imported by BOTH server and client.
 * Pitfall-proof: no magic numbers anywhere else in the codebase.
 */

// ─── Physics world units ──────────────────────────────────────────────────────
/** Pixels per game unit. 1 unit = 40 px in the client renderer. */
export const UNIT = 40;

/** Gravity scale passed to Matter.js (earth-like feel for block stacking). */
export const GRAVITY_Y = 1.8;

/** Physics simulation step in ms (30 Hz). */
export const PHYSICS_STEP_MS = 1000 / 30; // ~33.33 ms

/** How long (ms) all blocks must stay below velocity threshold before "settled". */
export const SETTLE_QUIET_MS = 500;

/** Velocity (px/s) below which a body is considered at rest. */
export const SETTLE_VELOCITY_THRESHOLD = 0.5;

// ─── World bounds ─────────────────────────────────────────────────────────────
/** Half-width of the playfield in game units (±11). Spec: "±11x". */
export const FIELD_HALF_WIDTH_UNITS = 11;

/** X clamp in world pixels. */
export const FIELD_X_MIN = -FIELD_HALF_WIDTH_UNITS * UNIT; // -440
export const FIELD_X_MAX = FIELD_HALF_WIDTH_UNITS * UNIT;  //  440

/**
 * Ground Y in world pixels (positive = down in Matter.js).
 * Blocks below y = +5 units are off-screen and excluded from scoring.
 * Spec: "no y < -5" means blocks that have FALLEN below floor level don't count.
 * In Matter.js coords (y increases downward), SCORE_Y_CUTOFF is the upper bound
 * for blocks that have dropped off — we track in "display" coords where up = negative.
 */
export const GROUND_Y_PX = 10 * UNIT;   // 400 px — solid ground plane
export const SCORE_Y_FLOOR_UNITS = -5;  // display-space cutoff (spec literal)

// ─── Block sizing ─────────────────────────────────────────────────────────────
/**
 * Variable block sizes (width × height in game units).
 * Blind player cycles through these via size_up / size_down commands.
 * Pitfall: keeping an array (not enum) lets us add sizes without client changes.
 */
export const BLOCK_SIZES: ReadonlyArray<{ w: number; h: number; label: string }> = [
  { w: 1, h: 1, label: "Small" },
  { w: 2, h: 1, label: "Medium" },
  { w: 3, h: 1, label: "Large" },
  { w: 4, h: 1, label: "X-Large" },
  { w: 2, h: 2, label: "Square" },
  { w: 1, h: 2, label: "Tall" },
];
export const DEFAULT_BLOCK_SIZE_INDEX = 1; // "Medium"

// ─── Block spawn ──────────────────────────────────────────────────────────────
/** Y in display units where a block spawns (top of screen, above visible area). */
export const SPAWN_Y_DISPLAY_UNITS = -8;

/** How many units left/right the blind player moves per command. */
export const MOVE_STEP_UNITS = 1;

/** Initial X position for a new block (center). */
export const SPAWN_X_DEFAULT = 0;

// ─── Room / round config ──────────────────────────────────────────────────────
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;

/** Seconds allowed for reconnect (Colyseus allowReconnection). Spec: 30. */
export const RECONNECT_TIMEOUT_S = 30;

/** Minimum history window for blindfold rotation (prevents immediate repeat). */
export const BLIND_HISTORY_MIN = 2;

// ─── Phase FSM ────────────────────────────────────────────────────────────────
export const PHASES = {
  LOBBY:    "lobby",
  PLACING:  "placing",  // blind player is positioning block
  DROPPING: "dropping", // block released, waiting for settle
  SCORING:  "scoring",  // score flash, transitioning
  ENDED:    "ended",
} as const;
export type Phase = typeof PHASES[keyof typeof PHASES];

// ─── Client message types (blind player → server) ────────────────────────────
export const CLIENT_MSGS = {
  MOVE_LEFT:   "move_left",
  MOVE_RIGHT:  "move_right",
  SIZE_UP:     "size_up",
  SIZE_DOWN:   "size_down",
  DROP:        "drop",
  CHAT:        "chat",
  START_GAME:  "start_game",  // host only
  END_GAME:    "end_game",    // host only
} as const;
export type ClientMsg = typeof CLIENT_MSGS[keyof typeof CLIENT_MSGS];

// ─── Server → client broadcast event names ───────────────────────────────────
export const SERVER_EVENTS = {
  PHASE_CHANGE:   "phase_change",
  SCORE_UPDATE:   "score_update",
  ROUND_START:    "round_start",
  GAME_OVER:      "game_over",
  HOST_CHANGED:   "host_changed",
  CHAT_MSG:       "chat_msg",
  ERROR:          "error",
} as const;

// ─── Chat sanitization ────────────────────────────────────────────────────────
export const CHAT_MAX_LENGTH = 200;
export const CHAT_RATE_LIMIT_PER_S = 3;

// ─── Utility: pure clamp (no DOM dependency, usable server-side) ─────────────
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Convert display-space X (units, ±11) to Matter.js world pixels. */
export function unitsToPx(units: number): number {
  return units * UNIT;
}

/** Convert Matter.js world pixels to display-space units. */
export function pxToUnits(px: number): number {
  return px / UNIT;
}
