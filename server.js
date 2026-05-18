/**
 * ============================================================
 *  BLINDFOLD TOWER  —  server.js  (v1.4.0)
 *  Single-file Node.js server (Colyseus + Matter.js + Express)
 * ============================================================
 *
 *  Changelog:
 *  v1.1 — Schema fix: @colyseus/schema v2 requires defineTypes()
 *         + constructor new MapSchema(). Old type() decorator left
 *         collections undefined → .size crash on first join.
 *  v1.2 — Room code fix: Colyseus nanoid(9) IDs truncated by
 *         client maxlength="8". Replaced with 6-char uppercase
 *         custom generator (no O/I/B). Client normalises to upper.
 *  v1.3 — Extension error suppressor added to client. 113-test
 *         simulation suite (simulate.js) added.
 *  v1.4 — spawn_block now generates random X/W/H server-side.
 *         Pending block ghost visible to all players on canvas.
 *         Live x-position label above ghost for sighted guidance.
 *         Blind player UI simplified to Spawn / Move / Drop.
 */

"use strict";

const express    = require("express");
const path       = require("path");
const cors       = require("cors");
const Matter     = require("matter-js");
const { Server, Room } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");
const { customAlphabet } = require("nanoid");

// ─── Room code generator ──────────────────────────────────────
// 6 chars, uppercase only, no O/I/B (visually ambiguous over video call)
// 23^6 = 148M combinations → negligible collision at <100 rooms
const ROOM_CODE_ALPHA  = "ACDEFGHJKLMNPQRSTUVWXYZ";
const makeRoomCode     = customAlphabet(ROOM_CODE_ALPHA, 6);

// ─── Config ──────────────────────────────────────────────────
const PORT            = process.env.PORT || 2567;
const TICK_HZ         = 30;
const TICK_MS         = 1000 / TICK_HZ;
const GRAVITY_Y       = 1.5;
const FLOOR_Y         = 550;
const STABLE_VEL      = 0.08;
const STABLE_MS       = 1500;
const DEAD_Y          = 620;
const MAX_CHAT_LEN    = 200;
const RECONN_SECS     = 30;
const ROUNDS_PER_GAME = 3;
const ROUND_SEC       = 90;

// ─── Schemas ─────────────────────────────────────────────────

class BlockState extends Schema {
  constructor() {
    super();
    this.x=0; this.y=0; this.angle=0; this.w=60; this.h=30;
    this.settled=false; this.ownerId="";
  }
}
defineTypes(BlockState,{x:"number",y:"number",angle:"number",w:"number",h:"number",settled:"boolean",ownerId:"string"});

class PlayerState extends Schema {
  constructor() {
    super();
    this.id=""; this.name=""; this.isBlind=false; this.isReady=false;
    this.isHost=false; this.score=0; this.blindCount=0;
    this.pendingX=400; this.pendingW=60; this.pendingH=30; this.hasPending=false;
  }
}
defineTypes(PlayerState,{id:"string",name:"string",isBlind:"boolean",isReady:"boolean",isHost:"boolean",score:"number",blindCount:"number",pendingX:"number",pendingW:"number",pendingH:"number",hasPending:"boolean"});

class ChatMsg extends Schema {
  constructor() { super(); this.from=""; this.text=""; this.ts=0; }
}
defineTypes(ChatMsg,{from:"string",text:"string",ts:"number"});

class GameState extends Schema {
  constructor() {
    super();
    this.players=new MapSchema(); this.blocks=new MapSchema(); this.chat=new ArraySchema();
    this.phase="lobby"; this.round=0; this.roundMax=ROUNDS_PER_GAME; this.timerMs=0;
    this.blindId=""; this.lastGuidance=""; this.stableHeight=0;
  }
}
defineTypes(GameState,{phase:"string",round:"number",roundMax:"number",timerMs:"number",blindId:"string",lastGuidance:"string",stableHeight:"number",players:{map:PlayerState},blocks:{map:BlockState},chat:[ChatMsg]});

// ─── Utilities ───────────────────────────────────────────────

function sanitizeChat(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/<[^>]*>/g,"")
    .replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))
    .trim().slice(0,MAX_CHAT_LEN);
}

function clamp(v,lo,hi) { return Math.max(lo,Math.min(hi,v)); }

let _uid=0;
function uid() { return `b${Date.now()}_${++_uid}`; }

function pickNextBlind(players, curId) {
  const el=[...players.values()].filter(p=>p.id!==curId);
  if (!el.length) return [...players.values()][0]?.id??null;
  const min=Math.min(...el.map(p=>p.blindCount));
  const pool=el.filter(p=>p.blindCount===min);
  return pool[Math.floor(Math.random()*pool.length)].id;
}

class RateLimit {
  constructor(max) { this._max=max; this._w={}; }
  allow(id) {
    const s=Math.floor(Date.now()/1000);
    if (!this._w[id]||this._w[id].s!==s) this._w[id]={s,n:0};
    return ++this._w[id].n<=this._max;
  }
}

// ─── TowerRoom ───────────────────────────────────────────────

class TowerRoom extends Room {

  // Override Colyseus room ID with our readable 6-char code
  // PITFALL-GUARD: must be set before onCreate so clients get correct ID
  onCreate(options) {
    this.roomId = makeRoomCode();   // ← THE FIX: replaces nanoid(9) default

    this.setState(new GameState());
    this._engine    = Matter.Engine.create({gravity:{y:GRAVITY_Y}});
    this._bodies    = {};
    this._stableFor = {};

    Matter.Composite.add(this._engine.world,[
      Matter.Bodies.rectangle(400,FLOOR_Y+25,800,50,{isStatic:true,label:"floor"}),
      Matter.Bodies.rectangle(-25, 300,50,700,{isStatic:true}),
      Matter.Bodies.rectangle(825, 300,50,700,{isStatic:true}),
    ]);

    this._chatRL    = new RateLimit(2);
    this._roundTimer= null;
    this._physTick  = null;
    this._hostId    = null;

    this.onMessage("ready",(client)=>{
      const p=this.state.players.get(client.sessionId);
      if(p) p.isReady=!p.isReady;
    });

    this.onMessage("host_start",(client)=>{
      if(client.sessionId!==this._hostId) return;
      if(this.state.phase!=="lobby") return;
      if(this.state.players.size<2) return;
      this._startGame();
    });

    this.onMessage("spawn_block",(client,data)=>{
      if(this.state.phase!=="playing") return;
      if(client.sessionId!==this.state.blindId) return;
      const p=this.state.players.get(client.sessionId);
      if(!p||p.hasPending) return;
      // Change 1: random X per spawn — server-generated, client X ignored
      // SPAWN_MARGIN keeps block clear of the static walls (x=-25 and x=825)
      // with max block width 120, margin 80 guarantees full block is in bounds
      const SPAWN_MARGIN = 80;
      p.pendingX = Math.round(SPAWN_MARGIN + Math.random() * (800 - SPAWN_MARGIN * 2));
      // Random size variation per drop: width 30-100px, height 18-50px
      p.pendingW = 30 + Math.round(Math.random() * 70);
      p.pendingH = 18 + Math.round(Math.random() * 32);
      p.hasPending=true;
    });

    this.onMessage("move_block",(client,data)=>{
      if(this.state.phase!=="playing") return;
      if(client.sessionId!==this.state.blindId) return;
      const p=this.state.players.get(client.sessionId);
      if(!p||!p.hasPending) return;
      const dx=clamp(typeof data.dx==="number"?data.dx:0,-50,50);
      p.pendingX=clamp(p.pendingX+dx,50,750);
    });

    this.onMessage("drop_block",(client)=>{
      if(this.state.phase!=="playing") return;
      if(client.sessionId!==this.state.blindId) return;
      const p=this.state.players.get(client.sessionId);
      if(!p||!p.hasPending) return;
      const id=uid();
      const body=Matter.Bodies.rectangle(p.pendingX,30,p.pendingW,p.pendingH,
        {restitution:0.05,friction:0.8,frictionAir:0.01,label:id});
      Matter.Composite.add(this._engine.world,body);
      this._bodies[id]=body; this._stableFor[id]=0;
      const bs=new BlockState();
      bs.x=p.pendingX; bs.y=30; bs.w=p.pendingW; bs.h=p.pendingH; bs.ownerId=client.sessionId;
      this.state.blocks.set(id,bs);
      p.hasPending=false; p.pendingX=p.pendingW=p.pendingH=0;
    });

    this.onMessage("chat",(client,data)=>{
      if(!this._chatRL.allow(client.sessionId)) return;
      const p=this.state.players.get(client.sessionId);
      if(!p) return;
      const text=sanitizeChat(typeof data.text==="string"?data.text:"");
      if(!text) return;
      const msg=new ChatMsg();
      msg.from=sanitizeChat(p.name).slice(0,20); msg.text=text; msg.ts=Date.now();
      this.state.chat.push(msg);
      while(this.state.chat.length>50) this.state.chat.splice(0,1);
    });

    this.onMessage("guidance",(client,data)=>{
      if(this.state.phase!=="playing") return;
      if(client.sessionId===this.state.blindId) return;
      const text=sanitizeChat(typeof data.text==="string"?data.text:"");
      if(text) this.state.lastGuidance=text;
    });
  }

  onJoin(client,options) {
    const name=sanitizeChat((options&&options.name)||"Player").slice(0,20)||"Player";
    const p=new PlayerState();
    p.id=client.sessionId; p.name=name;
    if(this.state.players.size===0){p.isHost=true;this._hostId=client.sessionId;}
    this.state.players.set(client.sessionId,p);
  }

  async onLeave(client,consented) {
    if(!consented){
      try{ await this.allowReconnection(client,RECONN_SECS); return; }catch{}
    }
    if(client.sessionId===this._hostId){
      const others=[...this.state.players.keys()].filter(id=>id!==client.sessionId);
      if(others.length){this._hostId=others[0];this.state.players.get(this._hostId).isHost=true;}
    }
    if(client.sessionId===this.state.blindId&&this.state.phase==="playing"){
      this.state.players.delete(client.sessionId); this._assignNextBlind();
    } else {
      this.state.players.delete(client.sessionId);
    }
    if(this.state.players.size<2&&this.state.phase==="playing") this._endGame();
  }

  onDispose(){ this._stopPhysics(); if(this._roundTimer) clearTimeout(this._roundTimer); }

  _startGame(){ this.state.round=0; this.state.players.forEach(p=>{p.score=0;p.blindCount=0;}); this._startRound(); }

  _startRound(){
    this.state.round++;
    if(this.state.round>ROUNDS_PER_GAME){this._endGame();return;}
    this._clearBlocks(); this._assignNextBlind();
    this.state.phase="playing"; this.state.timerMs=ROUND_SEC*1000;
    this.state.lastGuidance=""; this.state.stableHeight=0;
    this._startPhysics();
    this._roundTimer=setTimeout(()=>this._endRound(),ROUND_SEC*1000);
  }

  _endRound(){
    this._stopPhysics();
    if(this._roundTimer){clearTimeout(this._roundTimer);this._roundTimer=null;}
    const h=this._computeStableHeight();
    const blind=this.state.players.get(this.state.blindId);
    if(blind) blind.score+=h;
    this.state.stableHeight=h; this.state.phase="roundEnd";
    setTimeout(()=>this._startRound(),4000);
  }

  _endGame(){
    this._stopPhysics();
    if(this._roundTimer){clearTimeout(this._roundTimer);this._roundTimer=null;}
    this._clearBlocks(); this.state.phase="end";
  }

  _assignNextBlind(){
    const nextId=pickNextBlind(this.state.players,this.state.blindId);
    this.state.players.forEach(p=>{p.isBlind=false;});
    if(nextId){const np=this.state.players.get(nextId);if(np){np.isBlind=true;np.blindCount++;this.state.blindId=nextId;}}
  }

  _clearBlocks(){
    Object.values(this._bodies).forEach(b=>Matter.Composite.remove(this._engine.world,b));
    this._bodies={}; this._stableFor={};
    this.state.blocks.clear();
    this.state.players.forEach(p=>{p.hasPending=false;});
  }

  _startPhysics(){ if(this._physTick) return; this._physTick=setInterval(()=>this._tick(),TICK_MS); }
  _stopPhysics(){ if(this._physTick){clearInterval(this._physTick);this._physTick=null;} }

  _tick(){
    if(this.state.phase!=="playing") return;
    Matter.Engine.update(this._engine,TICK_MS);
    const toRemove=[];
    for(const [id,body] of Object.entries(this._bodies)){
      const bs=this.state.blocks.get(id);
      if(!bs) continue;
      if(body.position.y>DEAD_Y){toRemove.push(id);continue;}
      bs.x=Math.round(body.position.x*10)/10;
      bs.y=Math.round(body.position.y*10)/10;
      bs.angle=Math.round(body.angle*1000)/1000;
      const speed=Math.hypot(body.velocity.x,body.velocity.y);
      if(speed<STABLE_VEL){this._stableFor[id]=(this._stableFor[id]||0)+TICK_MS;}
      else{this._stableFor[id]=0;bs.settled=false;}
      if(this._stableFor[id]>=STABLE_MS) bs.settled=true;
    }
    toRemove.forEach(id=>{
      Matter.Composite.remove(this._engine.world,this._bodies[id]);
      delete this._bodies[id]; delete this._stableFor[id]; this.state.blocks.delete(id);
    });
    this.state.stableHeight=this._computeStableHeight();
    this.state.timerMs=Math.max(0,this.state.timerMs-TICK_MS);
  }

  _computeStableHeight(){
    let minY=FLOOR_Y;
    for(const bs of this.state.blocks.values()) if(bs.settled&&bs.y<minY) minY=bs.y;
    return Math.max(0,Math.round(FLOOR_Y-minY));
  }
}

// ─── Bootstrap ───────────────────────────────────────────────

const app=express();
app.use(cors());
app.use(express.static(path.join(__dirname,"client")));
app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"client","index.html")));

const gameServer=new Server({
  transport:new WebSocketTransport({server:require("http").createServer(app)}),
});
gameServer.define("tower",TowerRoom);
gameServer.listen(PORT).then(()=>{
  console.log(`\n🗼 Blindfold Tower v1.5.0 running on http://localhost:${PORT}`);
  console.log(`   Room codes: 6-char uppercase alpha (e.g. ZXKRAF)`);
  console.log(`   Colyseus Monitor: http://localhost:${PORT}/colyseus\n`);
}).catch(err=>{console.error("Failed to start:",err);process.exit(1);});
