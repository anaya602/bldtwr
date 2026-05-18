# Change Request — v1.5 Review Instructions
## UX fixes: spawn block visibility + blind coordinate removal

**File:** `client/index.html` only  
**Server:** No changes required  
**Risk:** Low — no schema, no physics, no room lifecycle touched  
**Tests:** `node simulate.js` must still show 115 passed, 0 failed after changes

---

## Background

Two UX issues identified in v1.4 testing:

1. **Spawn block not visible to sighted players** — the ghost block that should appear on the canvas when the blind player spawns is never drawn on sighted screens, because the state listeners that feed the drawing variables are gated to the player's own session only. Sighted players' local `hasPending` is always `false`, so the renderer clears the sprite every frame.

2. **Blind player sees x-coordinate** — a `#pending-info` div inside the black blindfold overlay shows "Block at x 380 — move left/right then drop". The blind player should have zero positional information. Guidance comes from teammates only.

---

## Change 1 of 4 — Add blind-player state variables (line 235–236)

**Location:** immediately after `let client,room,myName...`

**Current code (lines 235–236):**
```js
let client,room,myName="",isBlind=false,hasPending=false;
let pendingX=400,pendingW=60,pendingH=30;
```

**Replace with:**
```js
let client,room,myName="",isBlind=false,hasPending=false;
let pendingX=400,pendingW=60,pendingH=30;
// Separate vars that track the BLIND player's pending block.
// Used by renderLoop to draw the ghost sprite on sighted screens.
// Own-player vars (hasPending/pendingX/W/H) are only updated from
// the viewer's own session — they never reflect the blind player's state.
let blindHasPending=false,blindPendingX=400,blindPendingW=60,blindPendingH=30;
```

---

## Change 2 of 4 — Fix state listeners inside `players.onAdd` (lines 363–370)

**Location:** inside `bindRoomEvents()` → `room.state.players.onAdd((p,sessionId)=>{ ... })`

**Current code (lines 363–370):**
```js
    p.listen("isBlind",()=>{
      if(sessionId===room.sessionId){isBlind=p.isBlind;updateBlindUI();}
      renderScores();
    });
    p.listen("hasPending",()=>{if(sessionId===room.sessionId){hasPending=p.hasPending;updatePendingInfo();}});
    p.listen("pendingX",()=>{if(sessionId===room.sessionId){pendingX=p.pendingX;updatePendingInfo();}});
    p.listen("pendingW",()=>{if(sessionId===room.sessionId) pendingW=p.pendingW;});
    p.listen("pendingH",()=>{if(sessionId===room.sessionId) pendingH=p.pendingH;});
```

**Replace with:**
```js
    p.listen("isBlind",()=>{
      if(sessionId===room.sessionId){isBlind=p.isBlind;updateBlindUI();}
      // When a player loses the blind role (round rotation), clear the ghost
      if(!p.isBlind && sessionId!==room.sessionId) blindHasPending=false;
      renderScores();
    });
    // Own-player pending: drives the sendSpawn/sendMove/sendDrop guard logic
    p.listen("hasPending",()=>{
      if(sessionId===room.sessionId) hasPending=p.hasPending;
      // Blind player's pending: drives the ghost sprite on sighted screens
      if(p.isBlind) blindHasPending=p.hasPending;
    });
    p.listen("pendingX",()=>{
      if(sessionId===room.sessionId) pendingX=p.pendingX;
      if(p.isBlind) blindPendingX=p.pendingX;
    });
    p.listen("pendingW",()=>{
      if(sessionId===room.sessionId) pendingW=p.pendingW;
      if(p.isBlind) blindPendingW=p.pendingW;
    });
    p.listen("pendingH",()=>{
      if(sessionId===room.sessionId) pendingH=p.pendingH;
      if(p.isBlind) blindPendingH=p.pendingH;
    });
```

**Why both branches exist:**
- The `sessionId===room.sessionId` branch still runs. The blind player needs their own `hasPending` local var for the `sendSpawn`/`sendMove`/`sendDrop` guards.
- The `p.isBlind` branch is new. It runs on every client — including sighted ones — whenever the blind player's state changes. This is what feeds the ghost sprite vars.

---

## Change 3 of 4 — Update `renderLoop` to use blind-player vars for ghost (lines 296–314)

**Location:** inside `function renderLoop()`, the `pendingSprite` block

**Current code (lines 296–314):**
```js
  pendingSprite.clear();
  // Change 2: visible to ALL players (not just blind)
  if(hasPending){
    pendingSprite.lineStyle(2,0xfbbf24,0.9); pendingSprite.beginFill(0xfbbf24,0.25);
    pendingSprite.drawRoundedRect(-pendingW/2,-pendingH/2,pendingW,pendingH,4); pendingSprite.endFill();
    pendingSprite.position.set(pendingX,30);
    pendingSprite.lineStyle(1,0xfbbf24,0.4); pendingSprite.moveTo(0,pendingH/2); pendingSprite.lineTo(0,FLOOR_Y-30);
    // Live X-position label — sighted players can read exact number aloud
    if(window._pendingLabel){
      window._pendingLabel.text="x:"+Math.round(pendingX);
      window._pendingLabel.position.set(pendingX, 14);
      window._pendingLabel.visible=true;
    }
  } else {
    if(window._pendingLabel) window._pendingLabel.visible=false;
  }
```

**Replace with:**
```js
  pendingSprite.clear();
  // Ghost sprite: always keyed off the BLIND player's vars (blindHasPending/
  // blindPendingX/W/H), not the viewer's own vars.
  // On the blind player's own screen blindHasPending mirrors hasPending, so
  // behaviour is identical for them. On sighted screens blindHasPending is
  // updated by the new p.isBlind listener branch added in Change 2.
  if(blindHasPending){
    pendingSprite.lineStyle(2,0xfbbf24,0.9); pendingSprite.beginFill(0xfbbf24,0.25);
    pendingSprite.drawRoundedRect(-blindPendingW/2,-blindPendingH/2,blindPendingW,blindPendingH,4);
    pendingSprite.endFill();
    pendingSprite.position.set(blindPendingX,30);
    pendingSprite.lineStyle(1,0xfbbf24,0.4);
    pendingSprite.moveTo(0,blindPendingH/2);
    pendingSprite.lineTo(0,FLOOR_Y-30);
    // X-position label visible to sighted players for guiding by number
    if(window._pendingLabel){
      window._pendingLabel.text="x:"+Math.round(blindPendingX);
      window._pendingLabel.position.set(blindPendingX,14);
      window._pendingLabel.visible=true;
    }
  } else {
    if(window._pendingLabel) window._pendingLabel.visible=false;
  }
```

---

## Change 4 of 4 — Remove coordinate display from blind overlay

### 4a — Remove `#pending-info` CSS rule (line 55)

**Current code (line 55):**
```css
#pending-info{color:#94a3b8;font-size:.9rem;text-align:center;min-height:1.2em}
```

**Delete this line entirely.** The element is being removed from HTML; its CSS rule is dead code.

---

### 4b — Remove `#pending-info` div from blind overlay HTML (line 155)

**Current code (line 155):**
```html
        <div id="pending-info">Press Spawn — block appears at a random position</div>
```

**Delete this line entirely.** No replacement.  
The `#key-hint` div on the line immediately below it stays in place.

---

### 4c — Delete `updatePendingInfo()` function and its two call sites (lines 367–368, 419–424)

**Current code — call sites (lines 367–368):**
```js
    p.listen("hasPending",()=>{if(sessionId===room.sessionId){hasPending=p.hasPending;updatePendingInfo();}});
    p.listen("pendingX",()=>{if(sessionId===room.sessionId){pendingX=p.pendingX;updatePendingInfo();}});
```

These are replaced in full by Change 2 above, which does not call `updatePendingInfo()`.

**Current code — function body (lines 419–424):**
```js
function updatePendingInfo(){
  // Pending info: shown in blind overlay only
  $("pending-info").textContent=hasPending
    ?`Block at x\u202f${Math.round(pendingX)} — move left/right then drop`
    :"Press Spawn — block appears at a random position";
}
```

**Delete this entire function.** Nothing replaces it.

---

## Verification checklist

After applying all four changes, verify with the following manual test before committing:

| Test | Expected result |
|---|---|
| Open 3 browser tabs, create room, join all | All three see lobby normally |
| Start game — one tab goes blind | Black overlay appears on correct tab only |
| Blind tab: press Spawn | Amber ghost block appears on BOTH sighted canvases at a random x position with `x:NNN` label |
| Blind tab: press Left / Right | Ghost moves on sighted canvases in real time |
| Blind tab: check overlay content | No x-coordinate visible — guidance text only, Spawn button, move buttons, drop button, keyboard hint |
| Blind tab: press Drop | Block falls, ghost disappears from all canvases |
| Sighted tab: press Drop (should be ignored) | Nothing happens — only blind player can drop |
| Round ends, new blind player assigned | Ghost clears on all screens, ready for next spawn |
| `node simulate.js` | 115 passed, 0 failed |

---

## Summary of lines changed

| Location | Action |
|---|---|
| Line 236 (after existing `let pendingX...`) | Add 2 lines: `blindHasPending`, `blindPendingX/W/H` vars |
| Lines 363–370 (`p.listen` block inside `onAdd`) | Replace 8 lines with 18 lines — add `p.isBlind` branch to all four listeners |
| Lines 296–314 (`pendingSprite` block in `renderLoop`) | Replace `hasPending`/`pendingX/W/H` with `blindHasPending`/`blindPendingX/W/H` |
| Line 55 (CSS) | Delete `#pending-info` rule |
| Line 155 (HTML) | Delete `#pending-info` div |
| Lines 419–424 (JS) | Delete `updatePendingInfo()` function body |
| Lines 367–368 (call sites) | Removed as part of Change 2 replacement |
