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

import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
// Note: @colyseus/ws-transport 0.17 exports WebSocketTransport directly — verified.
import { createServer } from "http";
import express from "express";
import cors from "cors";
import { GameRoom } from "./GameRoom";

const PORT = parseInt(process.env.PORT ?? "2567", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";

// ─── Express HTTP server (health check + static fallback) ────────────────────
const app = express();

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: Date.now() });
});

app.get("/", (_req, res) => {
  res.json({ name: "Blindfold Tower Server", version: "1.5.0" });
});

// ─── Colyseus ────────────────────────────────────────────────────────────────
const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("blindfold_tower", GameRoom as any, {
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
