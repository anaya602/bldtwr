# 🏗 Blindfold Tower v1.5

## ⚠️ Important: How to Run

The game is a TypeScript/Vite project. You cannot open `index.html` directly in 
a browser — it requires a dev server to work.

---

## Quick Start (Local Dev)

### Terminal 1 — Server
```bash
cd server
npm install
npm run dev
# Starts on ws://localhost:2567
```

### Terminal 2 — Client  
```bash
cd client
npm install
npm run dev
# Opens http://localhost:5173 automatically
```

Open **3 browser tabs** to `http://localhost:5173` to test multiplayer.

---

## Using the Built Client (No Vite needed)

The `client/dist/` folder contains a pre-built version that works without Vite:

1. Start the server (Terminal 1 above)
2. Open `client/dist/index.html` **in a browser** (double-click it)
3. The client will connect to `ws://localhost:2567`

> The dist build uses relative paths (`./assets/`) so it works when opened as `file://`

---

## Deploy to Production

### Server → Render.com
- Build command: `cd server && npm install && npm run build`
- Start command: `node dist/server/index.js`
- Environment: `PORT=2567` `ALLOWED_ORIGIN=https://your-vercel-url.vercel.app`

### Client → Vercel
- Root directory: `client/`
- Framework: Vite
- Environment: `VITE_SERVER_URL=wss://your-render-slug.onrender.com`

---

## Lobby Flow

```
Landing screen
  → Enter display name
  → Click "Continue →"          ← requires Vite or dist/ to be served
  → Click "Create Room"         ← gets 4-char code (e.g. AB3X)
     OR "Join with Code"        ← enter host's code
  → Lobby: wait for players
  → Host clicks "Start Game ▶"
  → Game begins
```

## Common Issues

| Problem | Cause | Fix |
|---|---|---|
| Continue button does nothing | Opened `index.html` directly as `file://` without Vite | Run `npm run dev` in `client/` OR use `client/dist/index.html` |
| Can't connect to server | Server not running | Run `npm run dev` in `server/` |
| Room code not found | Server not running or wrong code | Check server terminal for errors |
