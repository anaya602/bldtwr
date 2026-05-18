/**
 * client/ReconnectHandler.ts
 * Uses colyseus.js 0.15 room.reconnectionToken (single token string).
 */

import { Client as ColyseusClient, Room } from "colyseus.js";

const STORAGE_KEY = "bt_reconnect_token";
const SERVER_KEY  = "bt_server_url";

export class ReconnectHandler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private readonly maxAttempts = 8;

  static save(reconnectionToken: string, serverUrl: string): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, reconnectionToken);
      sessionStorage.setItem(SERVER_KEY, serverUrl);
    } catch { /**/ }
  }

  static load(): { token: string; serverUrl: string } | null {
    try {
      const token = sessionStorage.getItem(STORAGE_KEY);
      const serverUrl = sessionStorage.getItem(SERVER_KEY);
      if (!token || !serverUrl) return null;
      return { token, serverUrl };
    } catch { return null; }
  }

  static clear(): void {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(SERVER_KEY);
    } catch { /**/ }
  }

  attempt(onReconnected: (room: Room) => void, onFailed: () => void): void {
    const session = ReconnectHandler.load();
    if (!session) { onFailed(); return; }
    this.attempts = 0;
    this._retry(session.token, session.serverUrl, onReconnected, onFailed);
  }

  private _retry(
    token: string, serverUrl: string,
    onReconnected: (room: Room) => void, onFailed: () => void
  ): void {
    if (this.attempts >= this.maxAttempts) {
      ReconnectHandler.clear(); onFailed(); return;
    }
    const delayMs = Math.min(250 * Math.pow(2, this.attempts), 5000);
    this.attempts++;
    this.timer = setTimeout(async () => {
      try {
        const client = new ColyseusClient(serverUrl);
        const room = await client.reconnect(token);
        ReconnectHandler.clear();
        onReconnected(room);
      } catch {
        this._retry(token, serverUrl, onReconnected, onFailed);
      }
    }, delayMs);
  }

  dispose(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }
}
