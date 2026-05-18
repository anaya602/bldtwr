/**
 * server/ScoreTracker.ts
 *
 * Computes tower height from settled block positions.
 *
 * Spec: "Score stable height (no y < -5)"
 * Design interpretation:
 *   - In Matter.js, Y increases downward. Ground is at GROUND_Y_PX (400 px).
 *   - A block's "display Y" = GROUND_Y_PX - body.position.y (flip axis).
 *   - SCORE_Y_FLOOR_UNITS = -5 means we exclude blocks whose display Y < -5 units,
 *     i.e., blocks that have fallen BELOW the -5 unit line (fallen off ledge).
 *   - Tower HEIGHT = highest display-Y top edge of any qualifying block.
 *     "Highest" = most negative display Y = smallest Matter.js Y.
 *
 * Pitfall: We do NOT use the block's current velocity to determine "stable" —
 * that's PhysicsEngine's job (isSettled flag). ScoreTracker trusts the flag.
 *
 * Pitfall: Score is computed AFTER all blocks settle, not per-block.
 * The height is the collective tower height, not an individual reward.
 */

import { PhysicsEngine } from "./PhysicsEngine";
import {
  GROUND_Y_PX,
  UNIT,
  SCORE_Y_FLOOR_UNITS,
} from "../shared/constants";

export interface ScoreResult {
  /** Tower height in display units (always >= 0). */
  heightUnits: number;
  /** Number of blocks that contributed to the score. */
  qualifyingBlocks: number;
  /** Number of blocks excluded (fell off / below floor). */
  excludedBlocks: number;
}

export class ScoreTracker {
  /**
   * Compute the current tower height from all settled blocks.
   *
   * Height = distance from ground to the topmost edge of the highest
   * qualifying block, expressed in game units.
   *
   * A block is "qualifying" if its top edge is at or above SCORE_Y_FLOOR_UNITS
   * in display space (i.e., it hasn't fallen off the edge / through the floor).
   */
  computeHeight(physics: PhysicsEngine): ScoreResult {
    const settled = physics.getSettledBlocks();

    if (settled.length === 0) {
      return { heightUnits: 0, qualifyingBlocks: 0, excludedBlocks: 0 };
    }

    let qualifyingBlocks = 0;
    let excludedBlocks = 0;
    // In Matter.js: lower Y value = higher in display space.
    // Start with ground level (GROUND_Y_PX) and find the minimum Y (highest block top).
    let minMatterY = GROUND_Y_PX; // "ground" in Matter.js coords

    for (const { y, h } of settled) {
      // Top edge of this block in Matter.js coords (lower = higher on screen)
      const topEdgeMatterY = y - h / 2;

      // Convert top edge to display units (0 = ground, positive = up)
      const topEdgeDisplayUnits = (GROUND_Y_PX - topEdgeMatterY) / UNIT;

      // Spec: exclude blocks below y = -5 display units.
      // A block below -5 display units has fallen off/under the floor region.
      if (topEdgeDisplayUnits < SCORE_Y_FLOOR_UNITS) {
        excludedBlocks++;
        continue;
      }

      qualifyingBlocks++;

      if (topEdgeMatterY < minMatterY) {
        minMatterY = topEdgeMatterY;
      }
    }

    // Height = distance from ground to the highest qualifying block top
    const heightPx = GROUND_Y_PX - minMatterY;
    const heightUnits = Math.max(0, heightPx / UNIT);

    return { heightUnits, qualifyingBlocks, excludedBlocks };
  }

  /**
   * Converts a height-units result to a display score integer.
   * Multiply by 10 for cleaner scoreboard numbers.
   */
  toScore(result: ScoreResult): number {
    return Math.round(result.heightUnits * 10);
  }
}
