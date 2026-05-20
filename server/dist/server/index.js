"use strict";
/**
 * server/index.ts
 *
 * Colyseus server boot.
 *
 * Pitfall-proof:
 * - PORT from env (Render.com sets this automatically).
 * - /health endpoint for Render health checks (prevents cold-boot loops).
 * - Room registered with a fixed name ("blindfold_tower") so clients
 *   always join/create by the same string — no magic on client side.
 * - CORS set permissively for dev; tighten to your Vercel URL in prod
 *   via ALLOWED_ORIGIN env var.
 * - Graceful SIGTERM handler so Render can restart cleanly.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const colyseus_1 = require("colyseus");
const ws_transport_1 = require("@colyseus/ws-transport");
// Note: @colyseus/ws-transport 0.17 exports WebSocketTransport directly — verified.
const http_1 = require("http");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const GameRoom_1 = require("./GameRoom");
const PORT = parseInt(process.env.PORT ?? "2567", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
// ─── Express HTTP server (health check + static fallback) ────────────────────
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: ALLOWED_ORIGIN }));
app.use(express_1.default.json());
app.get("/health", (_req, res) => {
    res.json({ status: "ok", ts: Date.now() });
});
app.get("/", (_req, res) => {
    res.json({ name: "Blindfold Tower Server", version: "1.5.0" });
});
// ─── Colyseus ────────────────────────────────────────────────────────────────
const httpServer = (0, http_1.createServer)(app);
const gameServer = new colyseus_1.Server({
    transport: new ws_transport_1.WebSocketTransport({ server: httpServer }),
});
gameServer.define("blindfold_tower", GameRoom_1.GameRoom, {
    // filterBy lets clients joinOrCreate with { roomCode: "ABCD" } and be
    // routed to an existing room with that code instead of creating a new one.
    filterBy: ["roomCode"],
});
// ─── Boot ─────────────────────────────────────────────────────────────────────
gameServer.listen(PORT).then(() => {
    console.log(`[Server] Blindfold Tower v1.5 listening on :${PORT}`);
    console.log(`[Server] CORS origin: ${ALLOWED_ORIGIN}`);
});
// ─── Graceful shutdown (Render SIGTERM) ───────────────────────────────────────
process.on("SIGTERM", () => {
    console.log("[Server] SIGTERM received — shutting down");
    gameServer.gracefullyShutdown().then(() => process.exit(0));
});
