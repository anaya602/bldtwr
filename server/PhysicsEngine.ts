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

import Matter from "matter-js";
import {
  GRAVITY_Y,
  PHYSICS_STEP_MS,
  SETTLE_QUIET_MS,
  SETTLE_VELOCITY_THRESHOLD,
  FIELD_X_MIN,
  FIELD_X_MAX,
  GROUND_Y_PX,
  UNIT,
  BLOCK_SIZES,
  clamp,
} from "../shared/constants";

export interface BlockBody {
  id: string;
  body: Matter.Body;
  ownerId: string;
  sizeIndex: number;
  /** Tick number when velocity first dropped below threshold. -1 = not quiet yet. */
  quietSinceTick: number;
  isSettled: boolean;
}

export interface PhysicsTick {
  /** Array of block updates to write into schema. */
  updates: Array<{
    id: string;
    x: number;
    y: number;
    angle: number;
    isSettled: boolean;
  }>;
  /** IDs of blocks that just became settled this tick. */
  newlySettled: string[];
}

export class PhysicsEngine {
  private engine: Matter.Engine;
  private world: Matter.World;
  private blocks: Map<string, BlockBody> = new Map();
  private blockCounter = 0;
  /** Monotonic tick counter — used for settle detection instead of wall clock. */
  private tickCount = 0;
  /** Ticks of quiet needed before a block is considered settled (500ms at 30Hz = 15 ticks). */
  private readonly SETTLE_TICKS = Math.ceil(SETTLE_QUIET_MS / PHYSICS_STEP_MS);

  constructor() {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: GRAVITY_Y },
      // Pitch: positionIterations / velocityIterations default is fine for
      // stacking games. Increase if blocks clip through each other.
      positionIterations: 6,
      velocityIterations: 4,
    });
    this.world = this.engine.world;
    this._createBounds();
  }

  // ─── World setup ────────────────────────────────────────────────────────────

  private _createBounds(): void {
    const thickness = 60; // thick enough to never tunnel through
    const fieldWidth = (FIELD_X_MAX - FIELD_X_MIN);
    const centerX = (FIELD_X_MAX + FIELD_X_MIN) / 2; // 0

    // Ground
    const ground = Matter.Bodies.rectangle(
      centerX,
      GROUND_Y_PX + thickness / 2,
      fieldWidth + thickness * 2,
      thickness,
      { isStatic: true, label: "ground", friction: 0.8, restitution: 0.1 }
    );

    // Left wall
    const leftWall = Matter.Bodies.rectangle(
      FIELD_X_MIN - thickness / 2,
      GROUND_Y_PX / 2,
      thickness,
      GROUND_Y_PX * 2,
      { isStatic: true, label: "wall_left" }
    );

    // Right wall
    const rightWall = Matter.Bodies.rectangle(
      FIELD_X_MAX + thickness / 2,
      GROUND_Y_PX / 2,
      thickness,
      GROUND_Y_PX * 2,
      { isStatic: true, label: "wall_right" }
    );

    Matter.World.add(this.world, [ground, leftWall, rightWall]);
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
  spawnBlock(xUnits: number, sizeIndex: number, ownerId: string): string {
    const safeSize = clamp(sizeIndex, 0, BLOCK_SIZES.length - 1);
    const { w, h } = BLOCK_SIZES[safeSize];

    // Clamp x so the block fits within walls (half-width of block must be inside)
    const halfW = (w * UNIT) / 2;
    const xClamped = clamp(
      xUnits * UNIT,
      FIELD_X_MIN + halfW,
      FIELD_X_MAX - halfW
    );

    // Spawn high above ground (negative Y = above ground in Matter.js when
    // ground is at GROUND_Y_PX). We spawn at y = -3 * UNIT = -120 px.
    const spawnY = -3 * UNIT;

    const body = Matter.Bodies.rectangle(
      xClamped,
      spawnY,
      w * UNIT,
      h * UNIT,
      {
        restitution: 0.05,   // nearly inelastic — blocks don't bounce wildly
        friction: 0.7,       // high friction for realistic stacking
        frictionAir: 0.02,   // slight air resistance
        density: 0.002,
        label: `block_${this.blockCounter}`,
      }
    );

    const id = `b${this.blockCounter++}`;

    const blockBody: BlockBody = {
      id,
      body,
      ownerId,
      sizeIndex: safeSize,
      quietSinceTick: -1,
      isSettled: false,
    };

    this.blocks.set(id, blockBody);
    Matter.World.add(this.world, body);

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
  moveHeldBlock(_xUnits: number): void {
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
  step(): PhysicsTick {
    Matter.Engine.update(this.engine, PHYSICS_STEP_MS);
    this.tickCount++;

    const updates: PhysicsTick["updates"] = [];
    const newlySettled: string[] = [];

    for (const [id, block] of this.blocks) {
      if (block.isSettled) continue;

      const { position, angle, velocity } = block.body;
      const speed = Math.sqrt(
        velocity.x * velocity.x + velocity.y * velocity.y
      );

      // Settle detection: tick-based quiet period (immune to wall-clock skew)
      if (speed < SETTLE_VELOCITY_THRESHOLD) {
        if (block.quietSinceTick === -1) {
          block.quietSinceTick = this.tickCount;
        } else if (this.tickCount - block.quietSinceTick >= this.SETTLE_TICKS) {
          block.isSettled = true;
          Matter.Body.setStatic(block.body, true);
          newlySettled.push(id);
        }
      } else {
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
  getSettledBlocks(): Array<{ id: string; y: number; h: number }> {
    const result: Array<{ id: string; y: number; h: number }> = [];
    for (const [id, block] of this.blocks) {
      if (!block.isSettled) continue;
      const size = BLOCK_SIZES[block.sizeIndex];
      result.push({
        id,
        y: block.body.position.y,
        h: size.h * UNIT,
      });
    }
    return result;
  }

  getAllBlocks(): ReadonlyMap<string, BlockBody> {
    return this.blocks;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Remove all dynamic blocks (call between rounds). */
  clearBlocks(): void {
    for (const block of this.blocks.values()) {
      Matter.World.remove(this.world, block.body);
    }
    this.blocks.clear();
    this.tickCount = 0;
  }

  /** Full teardown — call from GameRoom.onDispose(). */
  dispose(): void {
    this.clearBlocks();
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
  }
}
