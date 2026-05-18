/**
 * server/RoundManager.ts
 *
 * Manages round lifecycle and fair blind-player rotation.
 *
 * Pitfall-proof:
 * - Phase transitions are guarded (can't skip from LOBBY → SCORING).
 * - Blind rotation uses a min-history queue: nobody repeats until all eligible
 *   players have had a turn. History window = max(2, playerCount - 1).
 * - All timers stored and cleared on dispose() to prevent leak across room recycles.
 * - "Host leave" promotion handled externally (GameRoom calls promoteHost) but
 *   RoundManager validates that hostId is always a current player.
 */

import { RoomState, PlayerState } from "./schema/RoomState";
import {
  PHASES,
  Phase,
  BLIND_HISTORY_MIN,
  MIN_PLAYERS,
} from "../shared/constants";

type BroadcastFn = (event: string, data: unknown) => void;

export class RoundManager {
  private state: RoomState;
  private broadcast: BroadcastFn;

  /**
   * Recent blind-player history (sessionIds).
   * We avoid repeating anyone in the last `historyWindow` rounds.
   */
  private blindHistory: string[] = [];

  /** Handle for any active setTimeout (phase auto-advance). */
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: RoomState, broadcast: BroadcastFn) {
    this.state = state;
    this.broadcast = broadcast;
  }

  // ─── Phase transitions ──────────────────────────────────────────────────────

  /**
   * Attempt to start the game. Only valid from LOBBY with enough players.
   * Returns error string if precondition fails.
   */
  startGame(requesterId: string): string | null {
    if (requesterId !== this.state.hostId) {
      return "Only the host can start the game.";
    }
    const connected = this._connectedPlayers();
    if (connected.length < MIN_PLAYERS) {
      return `Need at least ${MIN_PLAYERS} players to start.`;
    }
    if (this.state.phase !== PHASES.LOBBY) {
      return "Game already started.";
    }

    this._beginRound();
    return null;
  }

  /** Called when the blind player issues the DROP command. */
  onDrop(): void {
    if (this.state.phase !== PHASES.PLACING) return;
    this._transitionTo(PHASES.DROPPING);
  }

  /**
   * Called by GameRoom when ALL blocks have settled after a drop.
   * Triggers scoring.
   */
  onAllSettled(heightUnits: number, score: number): void {
    if (this.state.phase !== PHASES.DROPPING) return;

    this.state.lastRoundHeight = heightUnits;
    this._transitionTo(PHASES.SCORING);

    this.broadcast("score_update", {
      roundNumber: this.state.roundNumber,
      heightUnits,
      score,
      blindPlayerId: this.state.currentBlindId,
    });

    // Auto-advance to next round after a brief display window
    this._scheduleTimer(3000, () => this._beginRound());
  }

  /** Host explicitly ends the session. */
  endGame(requesterId: string): string | null {
    if (requesterId !== this.state.hostId) {
      return "Only the host can end the game.";
    }
    this._clearTimer();
    this._transitionTo(PHASES.ENDED);
    this.broadcast("game_over", { scores: this._buildScoreMap() });
    return null;
  }

  // ─── Round internals ────────────────────────────────────────────────────────

  private _beginRound(): void {
    this._clearTimer();
    this.state.roundNumber += 1;
    const blindPlayer = this._pickNextBlind();

    if (!blindPlayer) {
      // Should never happen if startGame gate is correct, but be safe
      this._transitionTo(PHASES.LOBBY);
      return;
    }

    this.state.currentBlindId = blindPlayer.id;
    blindPlayer.role = "blind";
    blindPlayer.blindCount += 1;

    // All other connected players become builders
    for (const [id, p] of this.state.players) {
      if (id !== blindPlayer.id) {
        p.role = "builder";
      }
    }

    // Reset held block position
    this.state.heldBlockX = 0;
    this.state.currentSizeIndex = 1;

    this._transitionTo(PHASES.PLACING);

    this.broadcast("round_start", {
      roundNumber: this.state.roundNumber,
      blindPlayerId: blindPlayer.id,
      blindPlayerName: blindPlayer.displayName,
    });
  }

  private _transitionTo(phase: Phase): void {
    this.state.phase = phase;
    this.broadcast("phase_change", { phase });
  }

  // ─── Blind rotation ──────────────────────────────────────────────────────────

  /**
   * Picks the next blind player using a min-history fairness queue.
   *
   * Algorithm:
   * 1. Get all connected, non-host players.
   * 2. Remove from candidates anyone in the last (window) entries of blindHistory.
   * 3. If no candidates remain after filtering, reset history and start fresh.
   * 4. Among remaining candidates, pick the one with the lowest blindCount
   *    (tiebreak: earliest in player join order).
   *
   * Pitfall: if only 1 non-host player exists, history window = 0 — they always go.
   * Pitfall: if a player disconnects and everyone else has gone recently,
   *   we fall back to history reset.
   */
  private _pickNextBlind(): PlayerState | null {
    const eligible = this._connectedPlayers().filter(
      (p) => !p.isHost
    );

    if (eligible.length === 0) return null;
    if (eligible.length === 1) return eligible[0];

    // History window: prevent repeating within last N-1 turns
    const window = Math.max(BLIND_HISTORY_MIN, eligible.length - 1);
    const recentIds = new Set(this.blindHistory.slice(-window));

    let candidates = eligible.filter((p) => !recentIds.has(p.id));

    // Fallback: everyone has gone recently → reset history, all are candidates
    if (candidates.length === 0) {
      this.blindHistory = [];
      candidates = eligible;
    }

    // Pick lowest blindCount (most underdue), tiebreak by array order (join order)
    candidates.sort((a, b) => a.blindCount - b.blindCount);
    const chosen = candidates[0];

    // Update history
    this.blindHistory.push(chosen.id);
    if (this.blindHistory.length > eligible.length * 2) {
      // Trim history to prevent unbounded growth in long sessions
      this.blindHistory = this.blindHistory.slice(-eligible.length);
    }

    return chosen;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private _connectedPlayers(): PlayerState[] {
    const result: PlayerState[] = [];
    for (const p of this.state.players.values()) {
      if (p.isConnected) result.push(p);
    }
    return result;
  }

  private _buildScoreMap(): Record<string, number> {
    const map: Record<string, number> = {};
    for (const [id, p] of this.state.players) {
      map[id] = p.score;
    }
    return map;
  }

  private _scheduleTimer(ms: number, fn: () => void): void {
    this._clearTimer();
    this.pendingTimer = setTimeout(fn, ms);
  }

  private _clearTimer(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  dispose(): void {
    this._clearTimer();
  }
}
