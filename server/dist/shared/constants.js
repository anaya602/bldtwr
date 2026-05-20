"use strict";
/**
 * shared/constants.ts
 * Single source of truth imported by BOTH server and client.
 * Pitfall-proof: no magic numbers anywhere else in the codebase.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHAT_RATE_LIMIT_PER_S = exports.CHAT_MAX_LENGTH = exports.SERVER_EVENTS = exports.CLIENT_MSGS = exports.PHASES = exports.BLIND_HISTORY_MIN = exports.RECONNECT_TIMEOUT_S = exports.MAX_PLAYERS = exports.MIN_PLAYERS = exports.SPAWN_X_DEFAULT = exports.MOVE_STEP_UNITS = exports.SPAWN_Y_DISPLAY_UNITS = exports.DEFAULT_BLOCK_SIZE_INDEX = exports.BLOCK_SIZES = exports.SCORE_Y_FLOOR_UNITS = exports.GROUND_Y_PX = exports.FIELD_X_MAX = exports.FIELD_X_MIN = exports.FIELD_HALF_WIDTH_UNITS = exports.SETTLE_VELOCITY_THRESHOLD = exports.SETTLE_QUIET_MS = exports.PHYSICS_STEP_MS = exports.GRAVITY_Y = exports.UNIT = void 0;
exports.clamp = clamp;
exports.unitsToPx = unitsToPx;
exports.pxToUnits = pxToUnits;
// ─── Physics world units ──────────────────────────────────────────────────────
/** Pixels per game unit. 1 unit = 40 px in the client renderer. */
exports.UNIT = 40;
/** Gravity scale passed to Matter.js (earth-like feel for block stacking). */
exports.GRAVITY_Y = 1.8;
/** Physics simulation step in ms (30 Hz). */
exports.PHYSICS_STEP_MS = 1000 / 30; // ~33.33 ms
/** How long (ms) all blocks must stay below velocity threshold before "settled". */
exports.SETTLE_QUIET_MS = 500;
/** Velocity (px/s) below which a body is considered at rest. */
exports.SETTLE_VELOCITY_THRESHOLD = 0.5;
// ─── World bounds ─────────────────────────────────────────────────────────────
/** Half-width of the playfield in game units (±11). Spec: "±11x". */
exports.FIELD_HALF_WIDTH_UNITS = 11;
/** X clamp in world pixels. */
exports.FIELD_X_MIN = -exports.FIELD_HALF_WIDTH_UNITS * exports.UNIT; // -440
exports.FIELD_X_MAX = exports.FIELD_HALF_WIDTH_UNITS * exports.UNIT; //  440
/**
 * Ground Y in world pixels (positive = down in Matter.js).
 * Blocks below y = +5 units are off-screen and excluded from scoring.
 * Spec: "no y < -5" means blocks that have FALLEN below floor level don't count.
 * In Matter.js coords (y increases downward), SCORE_Y_CUTOFF is the upper bound
 * for blocks that have dropped off — we track in "display" coords where up = negative.
 */
exports.GROUND_Y_PX = 10 * exports.UNIT; // 400 px — solid ground plane
exports.SCORE_Y_FLOOR_UNITS = -5; // display-space cutoff (spec literal)
// ─── Block sizing ─────────────────────────────────────────────────────────────
/**
 * Variable block sizes (width × height in game units).
 * Blind player cycles through these via size_up / size_down commands.
 * Pitfall: keeping an array (not enum) lets us add sizes without client changes.
 */
exports.BLOCK_SIZES = [
    { w: 1, h: 1, label: "Small" },
    { w: 2, h: 1, label: "Medium" },
    { w: 3, h: 1, label: "Large" },
    { w: 4, h: 1, label: "X-Large" },
    { w: 2, h: 2, label: "Square" },
    { w: 1, h: 2, label: "Tall" },
];
exports.DEFAULT_BLOCK_SIZE_INDEX = 1; // "Medium"
// ─── Block spawn ──────────────────────────────────────────────────────────────
/** Y in display units where a block spawns (top of screen, above visible area). */
exports.SPAWN_Y_DISPLAY_UNITS = -8;
/** How many units left/right the blind player moves per command. */
exports.MOVE_STEP_UNITS = 1;
/** Initial X position for a new block (center). */
exports.SPAWN_X_DEFAULT = 0;
// ─── Room / round config ──────────────────────────────────────────────────────
exports.MIN_PLAYERS = 2;
exports.MAX_PLAYERS = 12;
/** Seconds allowed for reconnect (Colyseus allowReconnection). Spec: 30. */
exports.RECONNECT_TIMEOUT_S = 30;
/** Minimum history window for blindfold rotation (prevents immediate repeat). */
exports.BLIND_HISTORY_MIN = 2;
// ─── Phase FSM ────────────────────────────────────────────────────────────────
exports.PHASES = {
    LOBBY: "lobby",
    PLACING: "placing", // blind player is positioning block
    DROPPING: "dropping", // block released, waiting for settle
    SCORING: "scoring", // score flash, transitioning
    ENDED: "ended",
};
// ─── Client message types (blind player → server) ────────────────────────────
exports.CLIENT_MSGS = {
    MOVE_LEFT: "move_left",
    MOVE_RIGHT: "move_right",
    SIZE_UP: "size_up",
    SIZE_DOWN: "size_down",
    DROP: "drop",
    CHAT: "chat",
    START_GAME: "start_game", // host only
    END_GAME: "end_game", // host only
};
// ─── Server → client broadcast event names ───────────────────────────────────
exports.SERVER_EVENTS = {
    PHASE_CHANGE: "phase_change",
    SCORE_UPDATE: "score_update",
    ROUND_START: "round_start",
    GAME_OVER: "game_over",
    HOST_CHANGED: "host_changed",
    CHAT_MSG: "chat_msg",
    ERROR: "error",
};
// ─── Chat sanitization ────────────────────────────────────────────────────────
exports.CHAT_MAX_LENGTH = 200;
exports.CHAT_RATE_LIMIT_PER_S = 3;
// ─── Utility: pure clamp (no DOM dependency, usable server-side) ─────────────
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
/** Convert display-space X (units, ±11) to Matter.js world pixels. */
function unitsToPx(units) {
    return units * exports.UNIT;
}
/** Convert Matter.js world pixels to display-space units. */
function pxToUnits(px) {
    return px / exports.UNIT;
}
