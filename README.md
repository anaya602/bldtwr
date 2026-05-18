# 🗼 Blindfold Tower

Real-time multiplayer block-stacking game. One player is blindfolded each round and must stack physics blocks guided only by their teammates' voice instructions over Zoom or Meet.

## How it works

- 2–8 players join a room using a 6-letter code (e.g. `XKRAFD`)
- The host starts the game — one player is randomly chosen as blind
- The blind player's screen goes black; sighted players see the canvas
- A block spawns at a **random position** — sighted players see it as an amber ghost with a live `x:NNN` label
- Teammates call out guidance over Zoom ("move left, you're at 340")
- Blind player presses **Move Left / Right** to align, then **Drop**
- Blocks fall under real physics (gravity, friction, collisions)
- Score = height of the stable tower at round end
- Blind role rotates fairly — no-one is blind twice until all have had a turn
- 3 rounds total; cumulative score wins

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js 20 + Colyseus 0.15 |
| Physics | Matter.js 0.19 (server-side, 30 Hz) |
| Client | Pixi.js v7 (CDN) + Colyseus JS client (CDN) |
| Transport | WebSocket (Colyseus binary delta sync) |
| Deploy | Render.com (free tier) |

No build step. No TypeScript. No database. Drop on any Node 18+ server and run.

## Quickstart

```bash
unzip blindfold-tower-v1.4-final.zip
cd blindfold-tower
npm install
node simulate.js   # 113 tests — must show 0 failed
npm start          # → http://localhost:2567
```

## Deploy

See [INSTALL.md](./INSTALL.md) for full Git + Render instructions.

## Test suite

```bash
node simulate.js          # human-readable
node simulate.js --json   # also writes sim_output.json
```

Covers: schema init, room code format, player join, blind rotation,
spawn/move/drop guards, double-drop idempotency, physics gravity,
dead-block removal, height scoring, XSS sanitisation, rate limiting,
host-leave promotion, solo guard, reconnection model, extension error
suppressor, full 3-round game loop.

## Keyboard shortcuts (blind player)

| Key | Action |
|---|---|
| `S` | Spawn block |
| `A` / `←` | Move left |
| `D` / `→` | Move right |
| `Space` | Drop |

## Version history

| Version | Change |
|---|---|
| v1.0 | Initial release |
| v1.1 | Schema fix — `defineTypes()` + constructor `new MapSchema()` |
| v1.2 | Room code fix — 6-char uppercase, `maxlength="6"`, uppercase normalisation |
| v1.3 | Extension error suppressor, `simulate.js` (113 tests) |
| v1.4 | Random spawn X/W/H, pending block visible to all, live x-label, simplified blind UI |
