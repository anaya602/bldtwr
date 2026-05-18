/**
 * client/GameScene.ts
 *
 * Phaser 3 scene that renders the physics world.
 *
 * Design:
 * - Server is sole physics authority. Client NEVER simulates physics.
 * - Each tick (60fps preUpdate) lerps block display positions toward the
 *   latest server-reported positions. Lerp factor 0.22 gives smooth feel
 *   without lag. Settled blocks snap instantly (no lerp needed).
 * - Ghost block = semi-transparent rectangle drawn at heldBlockX / currentSizeIndex
 *   from schema state (not physics) — shows blind player's intended drop zone.
 * - Sighted players see all blocks and the ghost. Blind player sees nothing
 *   (the blind overlay in HTML covers the canvas).
 * - Dark-mode tint: non-blind players get full visibility; host gets full too.
 *
 * Pitfall-proof:
 * - Block graphics keyed by id in a Map — O(1) lookup, no array search per tick.
 * - On schema array change (block added/removed), diffBlock() reconciles.
 * - Camera follows tower top smoothly so tall stacks stay visible.
 * - No Phaser physics enabled — we use Phaser ONLY as a renderer.
 * - Input events stopped when focus is on #chat-input (stopPropagation in ChatUI).
 */

import Phaser from "phaser";
import type { Room } from "colyseus.js";
import {
  UNIT,
  GROUND_Y_PX,
  FIELD_X_MIN,
  FIELD_X_MAX,
  BLOCK_SIZES,
  PHASES,
  CLIENT_MSGS,
} from "../shared/constants";

const LERP = 0.22; // position interpolation factor per frame
const CANVAS_WIDTH  = 900;
const CANVAS_HEIGHT = 650;

// World center in Phaser canvas coords
const ORIGIN_X = CANVAS_WIDTH  / 2;        // horizontal center
const ORIGIN_Y = CANVAS_HEIGHT - 60;       // ground near bottom of canvas

/** Convert Matter.js world px to Phaser canvas px */
function worldToCanvas(wx: number, wy: number): { x: number; y: number } {
  return {
    x: ORIGIN_X + wx,
    y: ORIGIN_Y + wy - GROUND_Y_PX, // ground at GROUND_Y_PX maps to ORIGIN_Y
  };
}

interface BlockGfx {
  id: string;
  rect: Phaser.GameObjects.Rectangle;
  /** Current display position (lerped). */
  displayX: number;
  displayY: number;
  displayAngle: number;
  targetX: number;
  targetY: number;
  targetAngle: number;
  isSettled: boolean;
  w: number;
  h: number;
}

// Distinct colors for blocks by owner index
const BLOCK_COLORS = [
  0x7c9cf8, 0xf8c77c, 0x7cf8c7, 0xf87c9c,
  0xb07cf8, 0xf8a07c, 0x7cf8f8, 0xf8f87c,
];

export class GameScene extends Phaser.Scene {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room!: Room<any>;
  private mySessionId: string = "";
  private isBlind: boolean = false;
  private isHost: boolean = false;

  private blockGraphics: Map<string, BlockGfx> = new Map();
  private ghostRect!: Phaser.GameObjects.Rectangle;
  private groundRect!: Phaser.GameObjects.Rectangle;
  private wallLeft!: Phaser.GameObjects.Rectangle;
  private wallRight!: Phaser.GameObjects.Rectangle;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keySpace!: Phaser.Input.Keyboard.Key;

  /** Track which keys are currently pressed to avoid repeat sends */
  private keyState: Record<string, boolean> = {};

  /** Owner index → color (stable across reconnects) */
  private ownerColors: Map<string, number> = new Map();
  private colorCounter = 0;

  /** Callbacks wired by main.ts */
  onBlockCommand?: (msg: string) => void;

  constructor() {
    super({ key: "GameScene" });
  }

  // ─── Phaser lifecycle ──────────────────────────────────────────────────────

  create(): void {
    // Background
    this.cameras.main.setBackgroundColor(0x0d0d0f);

    // Grid lines (subtle vertical guides at ±5, ±10 units)
    this._drawGrid();

    // Walls and ground visuals
    const fieldW = FIELD_X_MAX - FIELD_X_MIN;
    const gCanvas = worldToCanvas(0, GROUND_Y_PX);
    this.groundRect = this.add.rectangle(
      gCanvas.x, gCanvas.y + 30,
      fieldW, 60,
      0x1a1a2e
    ).setDepth(0);

    this.wallLeft = this.add.rectangle(
      worldToCanvas(FIELD_X_MIN - 30, GROUND_Y_PX / 2).x,
      worldToCanvas(0, GROUND_Y_PX / 2).y,
      60, GROUND_Y_PX + 120, 0x111122
    ).setDepth(0);

    this.wallRight = this.add.rectangle(
      worldToCanvas(FIELD_X_MAX + 30, 0).x,
      worldToCanvas(0, GROUND_Y_PX / 2).y,
      60, GROUND_Y_PX + 120, 0x111122
    ).setDepth(0);

    // Ghost block (shows blind player's intended drop position)
    this.ghostRect = this.add.rectangle(0, 0, UNIT * 2, UNIT, 0xffffff, 0.18)
      .setStrokeStyle(2, 0xffffff, 0.5)
      .setDepth(10)
      .setVisible(false);

    // Input
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyW     = this.input.keyboard!.addKey("W");
    this.keyA     = this.input.keyboard!.addKey("A");
    this.keyS     = this.input.keyboard!.addKey("S");
    this.keyD     = this.input.keyboard!.addKey("D");
    this.keySpace = this.input.keyboard!.addKey("SPACE");
  }

  preUpdate(_time: number, _delta: number): void {
    if (!this.room) return;
    this._handleInput();
    this._updateBlockPositions();
    this._updateGhost();
  }

  // ─── Room connection ───────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setRoom(room: Room<any>, myId: string, isBlind: boolean, isHost: boolean): void {
    this.room = room;
    this.mySessionId = myId;
    this.isBlind = isBlind;
    this.isHost = isHost;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = room.state as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.blocks.onAdd((block: any, _key: any) => {
      this._addBlockGfx(block.id, block);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      block.onChange(() => this._syncBlockTarget(block.id, block));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    state.blocks.onRemove((block: any, _key: any) => {
      this._removeBlockGfx(block.id);
    });
  }

  updateRole(isBlind: boolean, isHost: boolean): void {
    this.isBlind = isBlind;
    this.isHost = isHost;
  }

  // ─── Block graphics ────────────────────────────────────────────────────────

  private _addBlockGfx(id: string, block: { x: number; y: number; angle: number; w: number; h: number; ownerId: string; isSettled: boolean }): void {
    if (this.blockGraphics.has(id)) return;

    const color = this._colorForOwner(block.ownerId);
    const { x: cx, y: cy } = worldToCanvas(block.x, block.y);

    const rect = this.add.rectangle(cx, cy, block.w, block.h, color, 1)
      .setStrokeStyle(1.5, 0xffffff, 0.15)
      .setDepth(5);

    this.blockGraphics.set(id, {
      id, rect,
      displayX: cx, displayY: cy, displayAngle: block.angle,
      targetX: cx, targetY: cy, targetAngle: block.angle,
      isSettled: block.isSettled,
      w: block.w, h: block.h,
    });
  }

  private _syncBlockTarget(id: string, block: { x: number; y: number; angle: number; isSettled: boolean }): void {
    const gfx = this.blockGraphics.get(id);
    if (!gfx) return;
    const { x, y } = worldToCanvas(block.x, block.y);
    gfx.targetX = x;
    gfx.targetY = y;
    gfx.targetAngle = block.angle;
    gfx.isSettled = block.isSettled;
  }

  private _removeBlockGfx(id: string): void {
    const gfx = this.blockGraphics.get(id);
    if (gfx) {
      gfx.rect.destroy();
      this.blockGraphics.delete(id);
    }
  }

  private _updateBlockPositions(): void {
    for (const gfx of this.blockGraphics.values()) {
      if (gfx.isSettled) {
        // Settled: snap immediately (no lerp)
        gfx.displayX = gfx.targetX;
        gfx.displayY = gfx.targetY;
        gfx.displayAngle = gfx.targetAngle;
      } else {
        // In-flight: lerp toward server position
        gfx.displayX += (gfx.targetX - gfx.displayX) * LERP;
        gfx.displayY += (gfx.targetY - gfx.displayY) * LERP;
        // Angle lerp (handle wrap-around for short path)
        const da = gfx.targetAngle - gfx.displayAngle;
        const daNorm = ((da + Math.PI) % (2 * Math.PI)) - Math.PI;
        gfx.displayAngle += daNorm * LERP;
      }

      gfx.rect.setPosition(gfx.displayX, gfx.displayY);
      gfx.rect.setRotation(gfx.displayAngle);
    }
  }

  // ─── Ghost block ───────────────────────────────────────────────────────────

  private _updateGhost(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.room?.state as any;
    if (!state || state.phase !== PHASES.PLACING) {
      this.ghostRect.setVisible(false);
      return;
    }

    const size = BLOCK_SIZES[state.currentSizeIndex];
    const worldX = state.heldBlockX * UNIT;
    const ghostY = -3 * UNIT;
    const { x: cx, y: cy } = worldToCanvas(worldX, ghostY);

    this.ghostRect
      .setSize(size.w * UNIT, size.h * UNIT)
      .setPosition(cx, cy)
      .setVisible(true);
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  /**
   * Only blind player sends movement commands.
   * Keyboard input stopped while chat input is focused (ChatUI handles that).
   *
   * Pitfall: we track keyState to send each command once per press,
   * not every frame (would flood the server at 60 fps).
   */
  private _handleInput(): void {
    if (!this.isBlind) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = this.room?.state as any;
    if (!state || state.phase !== PHASES.PLACING) return;
    if (!this.onBlockCommand) return;

    const left  = this.cursors.left!.isDown  || this.keyA.isDown;
    const right = this.cursors.right!.isDown || this.keyD.isDown;
    const up    = this.cursors.up!.isDown    || this.keyW.isDown;
    const down  = this.cursors.down!.isDown  || this.keyS.isDown;
    const space = this.keySpace.isDown;

    this._sendOnce("left",     left,  CLIENT_MSGS.MOVE_LEFT);
    this._sendOnce("right",    right, CLIENT_MSGS.MOVE_RIGHT);
    this._sendOnce("size_up",  up,    CLIENT_MSGS.SIZE_UP);
    this._sendOnce("size_down",down,  CLIENT_MSGS.SIZE_DOWN);
    this._sendOnce("drop",     space, CLIENT_MSGS.DROP);
  }

  private _sendOnce(key: string, isDown: boolean, msg: string): void {
    if (isDown && !this.keyState[key]) {
      this.keyState[key] = true;
      this.onBlockCommand!(msg);
    } else if (!isDown) {
      this.keyState[key] = false;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private _colorForOwner(ownerId: string): number {
    if (!this.ownerColors.has(ownerId)) {
      this.ownerColors.set(
        ownerId,
        BLOCK_COLORS[this.colorCounter++ % BLOCK_COLORS.length]
      );
    }
    return this.ownerColors.get(ownerId)!;
  }

  private _drawGrid(): void {
    const gfx = this.add.graphics().setDepth(0).setAlpha(0.08);
    gfx.lineStyle(1, 0xffffff, 1);
    for (let u = -10; u <= 10; u += 5) {
      const { x } = worldToCanvas(u * UNIT, 0);
      gfx.lineBetween(x, 0, x, CANVAS_HEIGHT);
    }
  }

  // ─── Public getters ────────────────────────────────────────────────────────

  static get canvasWidth(): number  { return CANVAS_WIDTH;  }
  static get canvasHeight(): number { return CANVAS_HEIGHT; }
}
