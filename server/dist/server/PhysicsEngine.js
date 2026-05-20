"use strict";
/**
 * server/PhysicsEngine.ts
 *
 * Wraps Matter.js for server-authoritative physics.
 *
 * Pitfall-proof:
 * - Single engine instance per room — no shared global state.
 * - Ground and wall bodies are static — never moved by solver.
 * - Settle detection uses a quiet-period debounce (not instant velocity check)
 *   so a block that briefly touches zero velocity mid-bounce doesn't false-trigger.
 * - All coordinates stored as pixels (Matter.js native). Conversion to units
 *   only happens at the schema boundary (ScoreTracker, schema writes).
 * - Bodies are removed from world on room dispose to prevent memory leaks.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PhysicsEngine = void 0;
const matter_js_1 = __importDefault(require("matter-js"));
const constants_1 = require("../shared/constants");
class PhysicsEngine {
    constructor() {
        this.blocks = new Map();
        this.blockCounter = 0;
        /** Monotonic tick counter — used for settle detection instead of wall clock. */
        this.tickCount = 0;
        /** Ticks of quiet needed before a block is considered settled (500ms at 30Hz = 15 ticks). */
        this.SETTLE_TICKS = Math.ceil(constants_1.SETTLE_QUIET_MS / constants_1.PHYSICS_STEP_MS);
        this.engine = matter_js_1.default.Engine.create({
            gravity: { x: 0, y: constants_1.GRAVITY_Y },
            // Pitch: positionIterations / velocityIterations default is fine for
            // stacking games. Increase if blocks clip through each other.
            positionIterations: 6,
            velocityIterations: 4,
        });
        this.world = this.engine.world;
        this._createBounds();
    }
    // ─── World setup ────────────────────────────────────────────────────────────
    _createBounds() {
        const thickness = 60; // thick enough to never tunnel through
        const fieldWidth = (constants_1.FIELD_X_MAX - constants_1.FIELD_X_MIN);
        const centerX = (constants_1.FIELD_X_MAX + constants_1.FIELD_X_MIN) / 2; // 0
        // Ground
        const ground = matter_js_1.default.Bodies.rectangle(centerX, constants_1.GROUND_Y_PX + thickness / 2, fieldWidth + thickness * 2, thickness, { isStatic: true, label: "ground", friction: 0.8, restitution: 0.1 });
        // Left wall
        const leftWall = matter_js_1.default.Bodies.rectangle(constants_1.FIELD_X_MIN - thickness / 2, constants_1.GROUND_Y_PX / 2, thickness, constants_1.GROUND_Y_PX * 2, { isStatic: true, label: "wall_left" });
        // Right wall
        const rightWall = matter_js_1.default.Bodies.rectangle(constants_1.FIELD_X_MAX + thickness / 2, constants_1.GROUND_Y_PX / 2, thickness, constants_1.GROUND_Y_PX * 2, { isStatic: true, label: "wall_right" });
        matter_js_1.default.World.add(this.world, [ground, leftWall, rightWall]);
    }
    // ─── Block factory ──────────────────────────────────────────────────────────
    /**
     * Creates a dynamic block body.
     * @param xUnits  Spawn X in game units (clamped to ±11 before use).
     * @param sizeIndex  Index into BLOCK_SIZES.
     * @param ownerId  SessionId of the player dropping this block.
     * @returns The block's unique id.
     *
     * Pitfall: x is clamped HERE, server-side, regardless of what the client sent.
     * This is the authoritative sanitisation point.
     */
    spawnBlock(xUnits, sizeIndex, ownerId) {
        const safeSize = (0, constants_1.clamp)(sizeIndex, 0, constants_1.BLOCK_SIZES.length - 1);
        const { w, h } = constants_1.BLOCK_SIZES[safeSize];
        // Clamp x so the block fits within walls (half-width of block must be inside)
        const halfW = (w * constants_1.UNIT) / 2;
        const xClamped = (0, constants_1.clamp)(xUnits * constants_1.UNIT, constants_1.FIELD_X_MIN + halfW, constants_1.FIELD_X_MAX - halfW);
        // Spawn high above ground (negative Y = above ground in Matter.js when
        // ground is at GROUND_Y_PX). We spawn at y = -3 * UNIT = -120 px.
        const spawnY = -3 * constants_1.UNIT;
        const body = matter_js_1.default.Bodies.rectangle(xClamped, spawnY, w * constants_1.UNIT, h * constants_1.UNIT, {
            restitution: 0.05, // nearly inelastic — blocks don't bounce wildly
            friction: 0.7, // high friction for realistic stacking
            frictionAir: 0.02, // slight air resistance
            density: 0.002,
            label: `block_${this.blockCounter}`,
        });
        const id = `b${this.blockCounter++}`;
        const blockBody = {
            id,
            body,
            ownerId,
            sizeIndex: safeSize,
            quietSinceTick: -1,
            isSettled: false,
        };
        this.blocks.set(id, blockBody);
        matter_js_1.default.World.add(this.world, body);
        return id;
    }
    /**
     * Teleports the held (static) ghost block to a new X position.
     * The ghost is NOT in the physics world — we only track its intended X
     * and store it in schema.heldBlockX for rendering. Drop() makes it dynamic.
     *
     * This method is effectively a no-op at the physics level but exists to
     * keep the API symmetric and document the design decision.
     */
    moveHeldBlock(_xUnits) {
        // Ghost block is schema-only; no physics body until drop.
        // See GameRoom.ts handleDrop() for the transition.
    }
    // ─── Simulation step ────────────────────────────────────────────────────────
    /**
     * Advance physics by one fixed step and return all dirty block states.
     * Called by GameRoom's setSimulationInterval at 30 Hz.
     *
     * Pitfall: Matter.Engine.update uses real wall-clock delta by default.
     * We pass PHYSICS_STEP_MS explicitly for deterministic simulation.
     */
    step() {
        matter_js_1.default.Engine.update(this.engine, constants_1.PHYSICS_STEP_MS);
        this.tickCount++;
        const updates = [];
        const newlySettled = [];
        for (const [id, block] of this.blocks) {
            if (block.isSettled)
                continue;
            const { position, angle, velocity } = block.body;
            const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y);
            // Settle detection: tick-based quiet period (immune to wall-clock skew)
            if (speed < constants_1.SETTLE_VELOCITY_THRESHOLD) {
                if (block.quietSinceTick === -1) {
                    block.quietSinceTick = this.tickCount;
                }
                else if (this.tickCount - block.quietSinceTick >= this.SETTLE_TICKS) {
                    block.isSettled = true;
                    matter_js_1.default.Body.setStatic(block.body, true);
                    newlySettled.push(id);
                }
            }
            else {
                // Reset if block starts moving again (e.g. hit by another block)
                block.quietSinceTick = -1;
            }
            updates.push({
                id,
                x: position.x,
                y: position.y,
                angle,
                isSettled: block.isSettled,
            });
        }
        return { updates, newlySettled };
    }
    // ─── Queries ────────────────────────────────────────────────────────────────
    /**
     * Returns all settled block positions (Matter.js pixels).
     * Used by ScoreTracker to compute tower height.
     */
    getSettledBlocks() {
        const result = [];
        for (const [id, block] of this.blocks) {
            if (!block.isSettled)
                continue;
            const size = constants_1.BLOCK_SIZES[block.sizeIndex];
            result.push({
                id,
                y: block.body.position.y,
                h: size.h * constants_1.UNIT,
            });
        }
        return result;
    }
    getAllBlocks() {
        return this.blocks;
    }
    // ─── Lifecycle ──────────────────────────────────────────────────────────────
    /** Remove all dynamic blocks (call between rounds). */
    clearBlocks() {
        for (const block of this.blocks.values()) {
            matter_js_1.default.World.remove(this.world, block.body);
        }
        this.blocks.clear();
        this.tickCount = 0;
    }
    /** Full teardown — call from GameRoom.onDispose(). */
    dispose() {
        this.clearBlocks();
        matter_js_1.default.World.clear(this.world, false);
        matter_js_1.default.Engine.clear(this.engine);
    }
}
exports.PhysicsEngine = PhysicsEngine;
