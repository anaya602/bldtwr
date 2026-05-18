/**
 * client/RoleOverlay.ts
 *
 * Manages all role-based UI overlays:
 *   - Blind overlay (full black screen + controls HUD)
 *   - Score flash
 *   - Scoreboard
 *   - Game HUD (round / blind player name / phase)
 *
 * Pitfall-proof:
 * - isBlind flag set by GameScene — never derived from server state twice.
 * - Score flash auto-hides after 2.5 s via a managed timer (cleared on dispose).
 * - All DOM queries cached at construction — no repeated getElementById in loops.
 * - textContent used everywhere — not innerHTML.
 */

import { BLOCK_SIZES } from "../shared/constants";

export class RoleOverlay {
  // Blind overlay elements
  private blindOverlay: HTMLElement;
  private blindPosDisplay: HTMLElement;
  private blindSizeDisplay: HTMLElement;

  // Score flash elements
  private scoreFlash: HTMLElement;
  private flashRound: HTMLElement;
  private flashScore: HTMLElement;
  private scoreFlashTimer: ReturnType<typeof setTimeout> | null = null;

  // Game HUD elements
  private hudRound: HTMLElement;
  private hudBlind: HTMLElement;
  private hudPhase: HTMLElement;
  private endGameBtn: HTMLButtonElement;

  // Scoreboard elements
  private scoreboard: HTMLElement;
  private sbRows: HTMLElement;

  // Lobby overlay
  private lobbyOverlay: HTMLElement;

  constructor() {
    this.blindOverlay    = document.getElementById("blind-overlay")!;
    this.blindPosDisplay = document.getElementById("blind-pos-display")!;
    this.blindSizeDisplay= document.getElementById("blind-size-display")!;
    this.scoreFlash      = document.getElementById("score-flash")!;
    this.flashRound      = document.getElementById("flash-round")!;
    this.flashScore      = document.getElementById("flash-score")!;
    this.hudRound        = document.getElementById("hud-round")!;
    this.hudBlind        = document.getElementById("hud-blind")!;
    this.hudPhase        = document.getElementById("hud-phase")!;
    this.endGameBtn      = document.getElementById("end-game-btn") as HTMLButtonElement;
    this.scoreboard      = document.getElementById("scoreboard")!;
    this.sbRows          = document.getElementById("sb-rows")!;
    this.lobbyOverlay    = document.getElementById("lobby-overlay")!;
  }

  // ─── Lobby ─────────────────────────────────────────────────────────────────

  showLobby(): void {
    this.lobbyOverlay.classList.remove("hidden");
    this.scoreboard.style.display = "none";
  }

  hideLobby(): void {
    this.lobbyOverlay.classList.add("hidden");
    this.scoreboard.style.display = "block";
  }

  // ─── Blind overlay ─────────────────────────────────────────────────────────

  showBlindOverlay(): void {
    this.blindOverlay.classList.add("active");
  }

  hideBlindOverlay(): void {
    this.blindOverlay.classList.remove("active");
  }

  /**
   * Called every time the server state updates heldBlockX or currentSizeIndex.
   * Shows the blind player their position and selected size as text.
   */
  updateBlindHUD(xUnits: number, sizeIndex: number): void {
    const dirStr = xUnits === 0 ? "Center" : xUnits > 0 ? `Right ${xUnits}` : `Left ${Math.abs(xUnits)}`;
    this.blindPosDisplay.textContent = `X: ${dirStr}`;

    const size = BLOCK_SIZES[Math.max(0, Math.min(sizeIndex, BLOCK_SIZES.length - 1))];
    this.blindSizeDisplay.textContent = `Size: ${size.label} (${size.w}×${size.h})`;
  }

  // ─── Score flash ────────────────────────────────────────────────────────────

  showScoreFlash(roundNumber: number, score: number): void {
    this.flashRound.textContent = `Round ${roundNumber}`;
    this.flashScore.textContent = String(score);

    // Force reflow to restart animation (in case it was already shown)
    this.scoreFlash.classList.remove("active");
    void this.scoreFlash.offsetWidth; // reflow
    this.scoreFlash.classList.add("active");

    if (this.scoreFlashTimer) clearTimeout(this.scoreFlashTimer);
    this.scoreFlashTimer = setTimeout(() => {
      this.scoreFlash.classList.remove("active");
    }, 2500);
  }

  // ─── Game HUD ───────────────────────────────────────────────────────────────

  updateHUD(roundNumber: number, blindName: string, phase: string): void {
    this.hudRound.textContent = String(roundNumber);
    this.hudBlind.textContent = blindName || "—";
    this.hudPhase.textContent = phase.toUpperCase();
  }

  showEndGameButton(onEnd: () => void): void {
    this.endGameBtn.style.display = "block";
    // Re-bind to avoid duplicate listeners
    this.endGameBtn.replaceWith(this.endGameBtn.cloneNode(true));
    this.endGameBtn = document.getElementById("end-game-btn") as HTMLButtonElement;
    this.endGameBtn.addEventListener("click", onEnd, { once: true });
  }

  hideEndGameButton(): void {
    this.endGameBtn.style.display = "none";
  }

  // ─── Scoreboard ─────────────────────────────────────────────────────────────

  updateScoreboard(players: Array<{ name: string; score: number }>): void {
    // Sort descending by score
    const sorted = [...players].sort((a, b) => b.score - a.score);
    this.sbRows.innerHTML = ""; // safe: we build from trusted data below

    for (const p of sorted) {
      const row = document.createElement("div");
      row.className = "sb-row";

      const name = document.createElement("span");
      name.className = "sb-name";
      name.textContent = p.name; // textContent — safe

      const pts = document.createElement("span");
      pts.className = "sb-pts";
      pts.textContent = String(p.score);

      row.appendChild(name);
      row.appendChild(pts);
      this.sbRows.appendChild(row);
    }
  }

  dispose(): void {
    if (this.scoreFlashTimer) clearTimeout(this.scoreFlashTimer);
  }
}
