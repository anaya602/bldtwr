"use strict";
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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoomState = exports.PlayerState = exports.BlockState = void 0;
const schema_1 = require("@colyseus/schema");
const constants_1 = require("../../shared/constants");
// ─── BlockState ───────────────────────────────────────────────────────────────
class BlockState extends schema_1.Schema {
    constructor() {
        super(...arguments);
        this.id = "";
        /** World X in pixels (Matter.js coords, origin = center of ground). */
        this.x = 0;
        /** World Y in pixels (Matter.js coords, positive = downward). */
        this.y = 0;
        /** Rotation in radians. */
        this.angle = 0;
        /** Width in pixels. */
        this.w = 0;
        /** Height in pixels. */
        this.h = 0;
        /** SessionId of the player who dropped this block. */
        this.ownerId = "";
        /**
         * True once the block has come to rest.
         * Client uses this to stop lerping and lock position.
         * ScoreTracker only reads settled blocks.
         */
        this.isSettled = false;
        /**
         * True while the blind player is still positioning (pre-drop).
         * Client renders a ghost outline in this state.
         */
        this.isHeld = true;
    }
}
exports.BlockState = BlockState;
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], BlockState.prototype, "id", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], BlockState.prototype, "x", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], BlockState.prototype, "y", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], BlockState.prototype, "angle", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], BlockState.prototype, "w", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], BlockState.prototype, "h", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], BlockState.prototype, "ownerId", void 0);
__decorate([
    (0, schema_1.type)("boolean"),
    __metadata("design:type", Boolean)
], BlockState.prototype, "isSettled", void 0);
__decorate([
    (0, schema_1.type)("boolean"),
    __metadata("design:type", Boolean)
], BlockState.prototype, "isHeld", void 0);
// ─── PlayerState ──────────────────────────────────────────────────────────────
class PlayerState extends schema_1.Schema {
    constructor() {
        super(...arguments);
        this.id = ""; // Colyseus sessionId
        this.displayName = "";
        /**
         * "host" | "blind" | "builder" | "spectator"
         * Not using an enum so new roles can be added without schema migration.
         */
        this.role = "builder";
        this.isConnected = true;
        this.isHost = false;
        /** Running total score (sum of stable tower heights this session). */
        this.score = 0;
        /** How many times this player has been the blind player. */
        this.blindCount = 0;
    }
}
exports.PlayerState = PlayerState;
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], PlayerState.prototype, "id", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], PlayerState.prototype, "displayName", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], PlayerState.prototype, "role", void 0);
__decorate([
    (0, schema_1.type)("boolean"),
    __metadata("design:type", Boolean)
], PlayerState.prototype, "isConnected", void 0);
__decorate([
    (0, schema_1.type)("boolean"),
    __metadata("design:type", Boolean)
], PlayerState.prototype, "isHost", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], PlayerState.prototype, "score", void 0);
__decorate([
    (0, schema_1.type)("int32"),
    __metadata("design:type", Number)
], PlayerState.prototype, "blindCount", void 0);
// ─── RoomState (root) ─────────────────────────────────────────────────────────
class RoomState extends schema_1.Schema {
    constructor() {
        super(...arguments);
        /**
         * Phase FSM string. Clients switch scene overlays based on this.
         * Using string (not int) so logs are human-readable.
         */
        this.phase = constants_1.PHASES.LOBBY;
        this.roundNumber = 0;
        /**
         * SessionId of the current blind player.
         * Empty string = nobody blind yet (lobby or between rounds).
         */
        this.currentBlindId = "";
        /**
         * SessionId of the host.
         * Separate from players[x].isHost so clients can identify host quickly.
         */
        this.hostId = "";
        /**
         * All players keyed by sessionId.
         * MapSchema gives O(1) lookup and delta-patches individual entries.
         */
        this.players = new schema_1.MapSchema();
        /**
         * All blocks in the current round, in spawn order.
         * ArraySchema patches only changed indices.
         *
         * Pitfall: we never reuse indices mid-round — only append.
         * Clearing and rebuilding the array each round is fine (full patch).
         */
        this.blocks = new schema_1.ArraySchema();
        /**
         * Index into BLOCK_SIZES for the currently held (pre-drop) block.
         * Stored in state so all clients see the blind player's current size choice.
         */
        this.currentSizeIndex = 1;
        /**
         * X position (in game units, ±11) of the block being held.
         * Stored so non-blind clients see the ghost block moving.
         */
        this.heldBlockX = 0;
        /**
         * Informational: last round's tower height (for score flash UI).
         */
        this.lastRoundHeight = 0;
        /**
         * Room join code (4-char uppercase). Set once on room creation.
         * Clients display this in the lobby for others to join.
         */
        this.roomCode = "";
    }
}
exports.RoomState = RoomState;
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], RoomState.prototype, "phase", void 0);
__decorate([
    (0, schema_1.type)("int32"),
    __metadata("design:type", Number)
], RoomState.prototype, "roundNumber", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], RoomState.prototype, "currentBlindId", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], RoomState.prototype, "hostId", void 0);
__decorate([
    (0, schema_1.type)({ map: PlayerState }),
    __metadata("design:type", Object)
], RoomState.prototype, "players", void 0);
__decorate([
    (0, schema_1.type)([BlockState]),
    __metadata("design:type", Object)
], RoomState.prototype, "blocks", void 0);
__decorate([
    (0, schema_1.type)("int32"),
    __metadata("design:type", Number)
], RoomState.prototype, "currentSizeIndex", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], RoomState.prototype, "heldBlockX", void 0);
__decorate([
    (0, schema_1.type)("float32"),
    __metadata("design:type", Number)
], RoomState.prototype, "lastRoundHeight", void 0);
__decorate([
    (0, schema_1.type)("string"),
    __metadata("design:type", String)
], RoomState.prototype, "roomCode", void 0);
