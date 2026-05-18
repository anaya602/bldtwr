# Blindfold Tower v1.4 — Git & Render Installation Guide

## Overview

This guide covers two paths:
- **Fresh install** — first time setting up the project
- **Update** — pulling a new version onto an existing setup

---

## Prerequisites

| Tool | Minimum version | Check |
|---|---|---|
| Node.js | 18 LTS | `node --version` |
| npm | 8+ | `npm --version` |
| Git | 2.x | `git --version` |
| GitHub account | — | github.com |
| Render account | — | render.com |

---

## Part 1 — GitHub Setup (fresh install)

### Step 1 — Create repository on GitHub

1. Go to **github.com → New repository**
2. Name: `blindfold-tower`
3. Visibility: **Private** (or Public — both work)
4. Skip README, .gitignore, licence — project already has these
5. Click **Create repository**
6. Copy the remote URL shown:
   ```
   https://github.com/YOUR_ORG/blindfold-tower.git
   ```

### Step 2 — Push the project

```bash
# Unzip the package
unzip blindfold-tower-v1.4.zip
cd blindfold-tower

# The repo is already initialised with one commit.
# Just add the remote and push:
git remote add origin https://github.com/YOUR_ORG/blindfold-tower.git
git push -u origin main
```

Verify on github.com — you should see 8 files in the `main` branch.

---

## Part 2 — Render Setup (fresh install)

### Step 3 — Create Render Web Service

1. Go to **render.com → New → Web Service**
2. Click **Connect a repository** → authorise GitHub → select `blindfold-tower`
3. Render reads `render.yaml` automatically. Settings pre-filled:

   | Field | Value |
   |---|---|
   | Name | `blindfold-tower` |
   | Environment | `Node` |
   | Build command | `npm install` |
   | Start command | `node server.js` |
   | Instance type | `Free` |

4. Environment variables (already in render.yaml, shown for reference):

   | Key | Value |
   |---|---|
   | `PORT` | `10000` |
   | `NODE_ENV` | `production` |

5. Click **Create Web Service**

### Step 4 — Confirm deployment

Render shows a live log. Wait for:

```
==> Build successful
==> Starting service
🗼 Blindfold Tower v1.2 running on http://0.0.0.0:10000
```

Your public URL is displayed at the top of the Render dashboard:
```
https://blindfold-tower-xxxx.onrender.com
```

Share this URL with your team in Zoom.

---

## Part 3 — Updating to a new version

Use this flow for every future update (v1.4 → v1.5, etc.).

### Step 5 — Run tests locally before anything else

```bash
cd blindfold-tower
node simulate.js
```

Expected output — must show `0 failed` before proceeding:
```
  RESULTS: 113 passed, 0 failed
  All tests passed. ✓
```

If tests fail, stop and fix before pushing.

### Step 6 — Commit and push

```bash
# Stage all modified files
git add .

# Commit with a clear message describing what changed
git commit -m "feat: describe your change here"

# Push to GitHub
git push
```

### Step 7 — Render auto-deploys

Render detects the push and starts a new deployment automatically within ~30 seconds. No action needed on render.com.

Monitor the deploy log in Render dashboard → your service → **Logs** tab. Wait for:
```
==> Build successful
==> Starting service
🗼 Blindfold Tower ...
```

### Step 8 — Smoke test

Open the public Render URL in 3 browser tabs. Verify:

1. Tab 1 → Create Room → 6-letter code appears (e.g. `XKRAFD`)
2. Tab 2 & 3 → enter code → Join → all three see the same lobby
3. All click Ready → Tab 1 (host) clicks Start Game
4. One tab goes black (blind screen), others see the canvas
5. Blind tab: press **Spawn block** → amber ghost appears on sighted canvases at a random position with `x:NNN` label
6. Blind tab: press Left/Right → ghost moves on sighted canvases in real time
7. Blind tab: press **Drop!** → block falls under gravity

---

## Commit message conventions

Use these prefixes so the git log stays readable:

| Prefix | Use for |
|---|---|
| `feat:` | New feature or behaviour change |
| `fix:` | Bug fix |
| `chore:` | Dependency update, config change, file tidy |
| `test:` | simulate.js changes only |
| `docs:` | DEPLOY.md, README, INSTALL.md changes |

Example:
```bash
git commit -m "fix: clamp pendingX on move_block to prevent wall clip"
git commit -m "feat: add round timer display to sighted HUD"
git commit -m "chore: bump nanoid to 3.3.12"
```

---

## Rollback

If a deployment breaks production:

```bash
# See recent commits
git log --oneline -10

# Revert to the last good commit (replace HASH with the commit hash)
git revert HEAD
git push
```

Or in Render dashboard → **Manual Deploy → Deploy a specific commit** → pick the previous good one.

---

## Environment variables

Set these in Render dashboard → **Environment** tab if you need to override:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `10000` | Render sets this automatically — do not change |
| `NODE_ENV` | `production` | Suppresses Colyseus dev logs |

For local dev, create a `.env` file (already in `.gitignore`, never committed):
```bash
PORT=2567
NODE_ENV=development
```

Then start with:
```bash
node -r dotenv/config server.js   # if dotenv installed
# or simply:
PORT=2567 npm start
```

---

## Free tier limits

| Limit | Value |
|---|---|
| Sleep after idle | 15 minutes |
| Wake time after sleep | ~30 seconds |
| Memory | 512 MB |
| Concurrent rooms | ~30 (Matter.js ~10MB per room) |

Upgrade to **Starter ($7/mo)** for always-on. No code changes needed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `git push` rejected | Remote has commits yours doesn't | `git pull --rebase origin main` then push again |
| Render build fails: `npm ERR!` | Bad package.json or missing dep | Check Render build log, fix locally, push |
| Render deploy stuck | Previous deploy still running | Render dashboard → Cancel deploy → re-deploy |
| Service URL gives 502 | Server crashed on start | Check Render Logs tab for error, fix and push |
| `node simulate.js` fails | Code regression | Fix the failing test before pushing |
| Room code not found after update | State cleared on restart | Normal — in-memory only, no persistence |
