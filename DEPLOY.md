# 🗼 Blindfold Tower v1.3 — Deployment Guide

## Changelog
| Version | Fix |
|---|---|
| v1.0 | Initial release |
| v1.1 | Schema fix: `@colyseus/schema` v2 requires `defineTypes()` + constructor `new MapSchema()` — old `type()` decorator left collections `undefined`, causing `.size` crash on first join |
| v1.2 | Room code fix: Colyseus default `nanoid(9)` mixed-case IDs truncated by `maxlength="8"` on client input. Replaced with 6-char uppercase-only custom generator. Client normalises to uppercase. |
| v1.3 | Extension error suppressor: Chrome extensions emit false `"message channel closed"` errors into the console. Added `unhandledrejection` filter that suppresses extension noise while surfacing real game errors. `simulate.js` added: 113 headless integration tests, 0 failures. |
| v1.4 | Spawn mechanic overhauled: block spawns at a server-random X/W/H per drop. Pending block ghost now visible on canvas to all players with a live `x:NNN` position label. Blind player UI simplified to Spawn / Move Left / Move Right / Drop — number inputs removed. |

---

## File Structure

```
blindfold-tower/
├── server.js       ← Entire backend (Colyseus rooms, Matter.js physics, Express)
├── client/
│   └── index.html  ← Entire frontend (Pixi.js v7, Colyseus client, no build step)
├── simulate.js     ← 113-test headless integration suite (run before deploying)
├── package.json    ← Dependencies + npm scripts
├── render.yaml     ← One-click Render.com deploy
└── DEPLOY.md       ← This file
```

---

## System Requirements

| Requirement | Version |
|---|---|
| Node.js | **18 or higher** |
| npm | 8+ (ships with Node 18) |

---

## Quickstart (local)

```bash
unzip blindfold-tower-v1.3.zip
cd blindfold-tower
npm install
node simulate.js        # run 113 tests — must show "0 failed" before deploying
npm start               # → http://localhost:2567
```

Open 3 browser tabs at `http://localhost:2567`. Tab 1 creates a room, gets a **6-letter code** (e.g. `XKRAFD`). Tabs 2–3 join with that code. Host clicks Start.

---

## Run Tests

```bash
node simulate.js          # human-readable output
node simulate.js --json   # also writes sim_output.json with full event log
npm test                  # alias for the above
```

Expected output:
```
  RESULTS: 113 passed, 0 failed
  All tests passed. ✓
```

Tests cover: schema init, room code format (200 samples, no collisions),
player join/host guard, fair blind rotation (9 rounds, verified equal distribution),
spawn/move/drop guards, double-drop idempotency, real Matter.js gravity, dead-block
removal, height scoring, XSS sanitization, rate limiting, host-leave promotion,
solo-player guard, reconnection window model, extension error suppressor, leaderboard.

---

## Deploy to Render (free, public URL)

1. Push folder to GitHub:
   ```bash
   git init && git add . && git commit -m "v1.3"
   git remote add origin https://github.com/YOUR_ORG/blindfold-tower.git
   git push -u origin main
   ```

2. Go to [render.com](https://render.com) → **New → Web Service** → connect repo.  
   `render.yaml` is auto-detected. Click **Deploy**.

3. You get `https://blindfold-tower-xxxx.onrender.com`. Share this URL in Zoom.

> **Free tier note:** Render free services sleep after 15 min idle. First request
> after sleep takes ~30s. Upgrade to Starter ($7/mo) for always-on.

---

## Deploy to any Linux VPS

```bash
# Install Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Upload and start
scp -r blindfold-tower/ user@your-server:~/
ssh user@your-server
cd blindfold-tower && npm install
npm install -g pm2
pm2 start server.js --name blindfold-tower
pm2 save && pm2 startup

# Open firewall
sudo ufw allow 2567/tcp
```

### Nginx reverse proxy (port 80/443)
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:2567;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # required for WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `2567` | TCP port |
| `NODE_ENV` | unset | Set to `production` to suppress Colyseus dev logs |

---

## Room Code Design

| Property | Value | Reason |
|---|---|---|
| Length | 6 chars | Fits `maxlength="6"` on client; easy to say aloud |
| Alphabet | `ACDEFGHJKLMNPQRSTUVWXYZ` | Uppercase only; no O/I/B (ambiguous over video call) |
| Combinations | 23⁶ = 148M | Negligible collision probability at <100 rooms |
| Client normalisation | `.toUpperCase()` on input event + before `joinById()` | Tolerates lowercase typing |

---

## Known Console Message (not a bug)

```
Uncaught (in promise) Error: A listener indicated an asynchronous response
by returning true, but the message channel closed before a response was received
```

**Source:** A browser extension (Grammarly, password manager, Zoom extension, MetaMask, etc.).  
**Impact:** Zero — does not affect WebSocket, room state, or gameplay.  
**Fix applied in v1.3:** `unhandledrejection` listener in `index.html` suppresses this specific
fingerprint while letting real game errors surface with a `[Blindfold Tower]` prefix.  
**Verify:** Open Chrome Incognito — error disappears, confirming extension origin.

---

## Keyboard Shortcuts (blind player)

| Key | Action |
|---|---|
| `S` | Spawn block |
| `A` / `←` | Move left |
| `D` / `→` | Move right |
| `Space` | Drop |

---

## Colyseus Monitor

Available at `http://localhost:2567/colyseus` (local only). Shows live rooms, player count, state diffs. Disable in production by removing the `@colyseus/monitor` package if installed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot read properties of undefined (reading 'size')` | Old `type()` schema syntax | Fixed in v1.1 — `defineTypes()` + constructor init |
| `room not found` on join | Truncated room code | Fixed in v1.2 — `maxlength="6"`, server uses 6-char codes |
| `message channel closed` in console | Browser extension | Fixed in v1.3 — suppressed; or test in Incognito |
| Port already in use | Another process on 2567 | `PORT=2568 npm start` |
| Players can't connect externally | Firewall | Open TCP port 2567 |
| Render service not responding | Free tier sleep | First request wakes it (~30s); upgrade plan |
| `npm test` fails | Code or schema regression | Fix the failing assertion before deploying |
