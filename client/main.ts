/**
 * client/main.ts
 *
 * Client orchestrator: lobby → connect → game → chat → reconnect.
 *
 * Pitfall-proof:
 * - Room typed as Room<any> on client side — server schema types not imported.
 *   All state accessed via (room.state as any) to avoid @colyseus/schema
 *   version mismatch between client lib (0.15) and server lib (4.x).
 * - seqId on every command → server dedup ring buffer.
 * - Blind buttons: touchstart + mousedown (not click) for ~300ms less latency.
 * - ReconnectHandler stores room.reconnectionToken (0.15 API).
 * - joinOrCreate used for both create and join; roomCode filter lets server
 *   route to the correct room (server must filter by metadata or state).
 *   NOTE: for a real deploy, "join by code" should use a lookup endpoint.
 *   For v1.5 we create-only from this client; joining uses the Colyseus
 *   lobby or a shared link with the room ID.
 */

import Phaser from "phaser";
import { Client as ColyseusClient, Room } from "colyseus.js";
import { GameScene } from "./GameScene";
import { ChatUI } from "./ChatUI";
import { RoleOverlay } from "./RoleOverlay";
import { ReconnectHandler } from "./ReconnectHandler";
import {
  PHASES,
  CLIENT_MSGS,
  SERVER_EVENTS,
} from "../shared/constants";

// ─── Config ──────────────────────────────────────────────────────────────────
const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ?? "ws://localhost:2567";

// ─── State ────────────────────────────────────────────────────────────────────
let colyseusClient: ColyseusClient;
let room: Room<any> | null = null;
let mySessionId = "";
let myDisplayName = "";
let isHost = false;
let isBlind = false;
let seqCounter = 0;
let sceneReady = false;  // prevent double setRoom calls

// ─── Sub-systems (init after DOM ready) ──────────────────────────────────────
let overlay: RoleOverlay;
let chatUI: ChatUI;
let gameScene: GameScene;
const reconnectHandler = new ReconnectHandler();

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
const nameInput    = $("name-input")    as HTMLInputElement;
const nameNextBtn  = $("name-next-btn") as HTMLButtonElement;
const stepName     = $("step-name");
const stepMode     = $("step-mode");
const stepJoin     = $("step-join");
const stepLobby    = $("step-lobby");
const createBtn    = $("create-btn")    as HTMLButtonElement;
const joinModeBtn  = $("join-mode-btn") as HTMLButtonElement;
const joinBtn      = $("join-btn")      as HTMLButtonElement;
const backBtn      = $("back-btn")      as HTMLButtonElement;
const codeInput    = $("code-input")    as HTMLInputElement;
const startBtn     = $("start-btn")     as HTMLButtonElement;
const roomCodeDisp = $("room-code-display");
const playerListEl = $("player-list");
const lobbyStatus  = $("lobby-status");
const lobbyError   = $("lobby-error");

// Blind control buttons
const btnLeft     = $("btn-left");
const btnRight    = $("btn-right");
const btnSizeUp   = $("btn-size-up");
const btnSizeDown = $("btn-size-down");
const btnDrop     = $("btn-drop");

// ─── Send command ─────────────────────────────────────────────────────────────
function sendCommand(msg: string, payload?: Record<string, unknown>): void {
  if (!room) return;
  room.send(msg, { seqId: String(++seqCounter), ...(payload ?? {}) });
}

// ─── Phaser boot ─────────────────────────────────────────────────────────────
function bootPhaser(): void {
  if (document.querySelector("#game-container canvas")) return; // already booted
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width:  GameScene.canvasWidth,
    height: GameScene.canvasHeight,
    parent: "game-container",
    backgroundColor: "#0d0d0f",
    scene: [GameScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_HORIZONTALLY,
    },
    disableContextMenu: true,
  };
  const game = new Phaser.Game(config);
  game.events.on("ready", () => {
    gameScene = game.scene.getScene("GameScene") as GameScene;
    gameScene.onBlockCommand = sendCommand;
  });
}

// ─── Lobby flow ───────────────────────────────────────────────────────────────
function showStep(step: HTMLElement): void {
  [stepName, stepMode, stepJoin, stepLobby].forEach(el => {
    (el as HTMLElement).style.display = "none";
  });
  step.style.display       = "flex";
  step.style.flexDirection = "column";
  step.style.gap           = "12px";
}

function setError(msg: string): void {
  lobbyError.textContent = msg;
  setTimeout(() => { lobbyError.textContent = ""; }, 4000);
}

nameNextBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) { setError("Please enter a display name."); return; }
  myDisplayName = name.slice(0, 20);
  showStep(stepMode);
});
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameNextBtn.click(); });

createBtn.addEventListener("click", async () => { await connectAndCreate(); });

joinModeBtn.addEventListener("click", () => { showStep(stepJoin); codeInput.focus(); });

joinBtn.addEventListener("click", async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) { setError("Enter a 4-letter room code."); return; }
  await connectAndJoinByCode(code);
});

backBtn.addEventListener("click", () => showStep(stepMode));
codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") joinBtn.click(); });
startBtn.addEventListener("click", () => sendCommand(CLIENT_MSGS.START_GAME));

// ─── Create room ─────────────────────────────────────────────────────────────
async function connectAndCreate(): Promise<void> {
  createBtn.disabled = true;
  lobbyError.textContent = "";
  try {
    colyseusClient = new ColyseusClient(SERVER_URL);
    room = await colyseusClient.create("blindfold_tower", {
      displayName: myDisplayName,
    });
    afterJoin();
  } catch (err) {
    console.error("Create error:", err);
    setError("Could not create room. Is the server running?");
  } finally {
    createBtn.disabled = false;
  }
}

// ─── Join by code ─────────────────────────────────────────────────────────────
// Colyseus 0.17 server: joinOrCreate filters by options passed to onCreate/onJoin.
// The server reads options.roomCode in onJoin to know which room the client wants.
// In Colyseus 0.15 client, filterBy is set server-side via `gameServer.define(..., { filterBy: ['roomCode'] })`.
// For v1.5, we use joinOrCreate with roomCode option — server must have filterBy configured.
async function connectAndJoinByCode(code: string): Promise<void> {
  joinBtn.disabled = true;
  lobbyError.textContent = "";
  try {
    colyseusClient = new ColyseusClient(SERVER_URL);
    room = await colyseusClient.joinOrCreate("blindfold_tower", {
      displayName: myDisplayName,
      roomCode: code,
    });
    afterJoin();
  } catch (err) {
    console.error("Join error:", err);
    setError("Room not found. Check the code and try again.");
  } finally {
    joinBtn.disabled = false;
  }
}

function afterJoin(): void {
  if (!room) return;
  mySessionId = room.sessionId;
  // Save reconnect token (colyseus.js 0.15 API)
  ReconnectHandler.save(
    (room as any).reconnectionToken ?? room.sessionId,
    SERVER_URL
  );
  chatUI.setMySessionId(mySessionId);
  attachRoomListeners();
  showStep(stepLobby);
}

// ─── Room listeners ──────────────────────────────────────────────────────────
function attachRoomListeners(): void {
  if (!room) return;
  const state = room.state as any;

  // Room code from server
  room.onMessage("room_info", (data: any) => {
    roomCodeDisp.textContent = data.roomCode ?? "——";
  });

  // Player list changes
  state.players.onAdd((player: any, _key: any) => {
    player.onChange(() => {
      // Detect own role/host changes
      if (player.id === mySessionId) {
        isHost  = player.isHost;
        isBlind = player.role === "blind";
        updateHostUI();
        updateBlindUI(state);
      }
      updateLobbyPlayerList(state);
      updateScoreboard(state);
    });
    updateLobbyPlayerList(state);
    chatUI.addSystemMessage(`${player.displayName} joined.`);
    updateScoreboard(state);
  });

  state.players.onRemove((player: any, _key: any) => {
    updateLobbyPlayerList(state);
    chatUI.addSystemMessage(`${player.displayName} left.`);
    updateScoreboard(state);
  });

  // Global state changes (phase, heldBlockX, currentSizeIndex, roundNumber)
  state.onChange((changes: any[]) => {
    onStateChange(state, changes);
  });

  // Named server events
  room.onMessage(SERVER_EVENTS.PHASE_CHANGE, (data: any) => {
    onPhaseChange(data.phase, state);
  });

  room.onMessage(SERVER_EVENTS.ROUND_START, (data: any) => {
    isBlind = data.blindPlayerId === mySessionId;
    gameScene?.updateRole(isBlind, isHost);
    updateBlindUI(state);
    chatUI.addSystemMessage(
      `Round ${data.roundNumber}: ${data.blindPlayerName} is blindfolded!`
    );
  });

  room.onMessage(SERVER_EVENTS.SCORE_UPDATE, (data: any) => {
    overlay.showScoreFlash(data.roundNumber, data.score);
    updateScoreboard(state);
  });

  room.onMessage(SERVER_EVENTS.CHAT_MSG, (data: any) => {
    chatUI.addMessage({
      senderId:   data.senderId,
      senderName: data.senderName,
      text:       data.text,
      timestamp:  Date.now(),
    });
  });

  room.onMessage(SERVER_EVENTS.HOST_CHANGED, (data: any) => {
    if (data.newHostId === mySessionId) {
      isHost = true;
      updateHostUI();
      chatUI.addSystemMessage("You are now the host.");
    } else {
      chatUI.addSystemMessage(`${data.newHostName} is now the host.`);
    }
  });

  room.onMessage(SERVER_EVENTS.GAME_OVER, () => {
    chatUI.addSystemMessage("Game over! Final scores shown.");
    overlay.hideEndGameButton();
    overlay.showLobby();
  });

  room.onMessage(SERVER_EVENTS.ERROR, (data: any) => {
    chatUI.addSystemMessage(`⚠ ${data.message}`);
  });

  // Disconnect → attempt reconnect
  room.onLeave(() => {
    chatUI.addSystemMessage("Disconnected. Attempting to reconnect…");
    reconnectHandler.attempt(
      (newRoom) => {
        room = newRoom as Room<any>;
        mySessionId = room.sessionId;
        ReconnectHandler.save(
          (room as any).reconnectionToken ?? room.sessionId,
          SERVER_URL
        );
        chatUI.setMySessionId(mySessionId);
        sceneReady = false;
        attachRoomListeners();
        chatUI.addSystemMessage("Reconnected!");
      },
      () => {
        chatUI.addSystemMessage("Could not reconnect. Please refresh.");
        overlay.showLobby();
        ReconnectHandler.clear();
      }
    );
  });
}

// ─── State change handlers ────────────────────────────────────────────────────
function onStateChange(state: any, _changes: any[]): void {
  overlay.updateHUD(
    state.roundNumber,
    getBlindPlayerName(state),
    state.phase
  );
  if (state.phase === PHASES.PLACING && isBlind) {
    overlay.updateBlindHUD(state.heldBlockX, state.currentSizeIndex);
  }
}

function onPhaseChange(phase: string, state: any): void {
  if (phase === PHASES.PLACING) {
    overlay.hideLobby();

    // Wire Phaser scene to room exactly once
    if (!sceneReady && gameScene) {
      gameScene.setRoom(room!, mySessionId, isBlind, isHost);
      sceneReady = true;
    }
    if (isBlind) overlay.showBlindOverlay();
    else overlay.hideBlindOverlay();

  } else if (phase === PHASES.DROPPING) {
    overlay.hideBlindOverlay();

  } else if (phase === PHASES.LOBBY || phase === PHASES.ENDED) {
    overlay.showLobby();
    overlay.hideBlindOverlay();
    sceneReady = false;
  }

  updateScoreboard(state);
  overlay.updateHUD(state.roundNumber, getBlindPlayerName(state), phase);
}

function updateLobbyPlayerList(state: any): void {
  const lines: string[] = [];
  let count = 0;
  state.players.forEach((p: any) => {
    const tag  = p.isHost      ? " <em style='color:#f8c77c;font-style:normal'>(host)</em>" : "";
    const conn = p.isConnected ? "" : " <span style='color:#f87c7c'>⚠ reconnecting</span>";
    lines.push(`<span>${escHtml(p.displayName)}</span>${tag}${conn}`);
    count++;
  });
  playerListEl.innerHTML = lines.join("<br>");
  lobbyStatus.textContent =
    count < 2
      ? `Waiting for more players (${count}/2 min)…`
      : isHost
        ? "Ready! Press Start when everyone is here."
        : "Waiting for host to start…";
}

function updateHostUI(): void {
  if (isHost) {
    startBtn.style.display = "block";
    overlay.showEndGameButton(() => sendCommand(CLIENT_MSGS.END_GAME));
  }
}

function updateBlindUI(state: any): void {
  if (isBlind && state.phase === PHASES.PLACING) {
    overlay.showBlindOverlay();
    overlay.updateBlindHUD(state.heldBlockX, state.currentSizeIndex);
  } else {
    overlay.hideBlindOverlay();
  }
}

function updateScoreboard(state: any): void {
  const players: Array<{ name: string; score: number }> = [];
  state.players.forEach((p: any) => {
    players.push({ name: p.displayName, score: p.score });
  });
  overlay.updateScoreboard(players);
}

function getBlindPlayerName(state: any): string {
  let name = "—";
  state.players.forEach((p: any) => {
    if (p.id === state.currentBlindId) name = p.displayName;
  });
  return name;
}

/** Minimal HTML escape for content inserted via innerHTML in player list. */
function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Blind touch controls ─────────────────────────────────────────────────────
function bindBlindButton(el: HTMLElement, msg: string): void {
  const handler = (e: Event) => {
    e.preventDefault();
    if (!isBlind) return;
    sendCommand(msg);
    // Visual feedback
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 120);
  };
  el.addEventListener("touchstart", handler, { passive: false });
  el.addEventListener("mousedown",  handler);
}

bindBlindButton(btnLeft,     CLIENT_MSGS.MOVE_LEFT);
bindBlindButton(btnRight,    CLIENT_MSGS.MOVE_RIGHT);
bindBlindButton(btnSizeUp,   CLIENT_MSGS.SIZE_UP);
bindBlindButton(btnSizeDown, CLIENT_MSGS.SIZE_DOWN);
bindBlindButton(btnDrop,     CLIENT_MSGS.DROP);

// ─── Init ─────────────────────────────────────────────────────────────────────
overlay = new RoleOverlay();
chatUI  = new ChatUI((text) => sendCommand(CLIENT_MSGS.CHAT, { text }));
overlay.showLobby();

// Boot Phaser in background (canvas renders immediately, scenes wait for room)
bootPhaser();

// Check for stored reconnect session on load
const stored = ReconnectHandler.load();
if (stored) {
  chatUI.addSystemMessage("Reconnecting to previous session…");
  reconnectHandler.attempt(
    (newRoom) => {
      room = newRoom as Room<any>;
      mySessionId = room.sessionId;
      ReconnectHandler.save(
        (room as any).reconnectionToken ?? room.sessionId,
        SERVER_URL
      );
      chatUI.setMySessionId(mySessionId);
      attachRoomListeners();
      overlay.hideLobby();
      chatUI.addSystemMessage("Reconnected to previous session!");
    },
    () => {
      chatUI.addSystemMessage("Previous session expired.");
    }
  );
}

nameInput.focus();
