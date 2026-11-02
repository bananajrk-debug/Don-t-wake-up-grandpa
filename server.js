'use strict';
/**
 * おれが金づちだ（仮） プロトタイプサーバー
 *
 * 起動:  npm install → npm start → http://localhost:3000
 *
 * ルール: 全員、工具（金づち・ノコギリ・はしご）に変身できる。でも工具は自分では動けない。
 *         仲間に拾って使ってもらい、嵐が来る前に家を建てる。
 *
 * 役割分担
 *  - 人間の移動 … 各クライアントが計算して位置を送る
 *  - 工具・変身・建築の進行・目回り・タイマー … サーバーが判定して配信する
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// =====================================================================
// ゲームの定数（ここを変えるとバランス調整できる）
// =====================================================================
const ROUND_TIME = 240;        // 嵐が来るまでの秒数
const NAIL_HITS = 3;           // 釘1本を打ち込むのに必要な回数
const SAW_STROKES = 8;         // 板1枚を切るのに必要なストローク数
const GRAVITY = -18;
const BOUNDS = { x0: -11.5, x1: 11.5, z0: -8.5, z1: 8.5 };
const HOUSE = { x0: -3, x1: 3, z0: -2, z1: 2, h: 2.4 };
const SAWHORSE = { x: 7, z: 0 };
const RACK = { x: -8, z: -4.4 };
const TOOL_TYPES = ['hammer', 'saw', 'ladder'];
const TOOL_NAMES = { hammer: '金づち', saw: 'ノコギリ', ladder: 'はしご' };
const EMOTES = ['痛い！', 'もっと優しく！', '交代して！'];
const DIZZY = { nail: 14, bonk: 18, miss: 6, saw: 9, sawMiss: 4, ladderSwing: 8, throw: 10, land: 8, climbPerSec: 4 };

// 家の部位。ノコギリで切った板が、この順番で家に取り付けられる
function makeParts() {
  const part = (id, name, nails) => ({ id, name, cut: false, done: false, nails: nails.map(([x, y, z]) => ({ x, y, z, hits: 0 })) });
  return [
    part('front', '正面の壁', [[-2, 0.7, 2.05], [0, 1.25, 2.05], [2, 0.7, 2.05]]),
    part('right', '右の壁', [[3.05, 1.25, -1], [3.05, 0.7, 0], [3.05, 1.25, 1]]),
    part('back', '裏の壁', [[2, 0.7, -2.05], [0, 1.25, -2.05], [-2, 0.7, -2.05]]),
    part('left', '左の壁', [[-3.05, 1.25, 1], [-3.05, 0.7, 0], [-3.05, 1.25, -1]]),
    part('roof', '屋根', [[-2, 2.45, 2.05], [2, 2.45, 2.05], [2, 2.45, -2.05], [-2, 2.45, -2.05]]),
  ];
}

// =====================================================================
// 小物
// =====================================================================
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const fwd = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const right = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });
const dist2d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// 家の中に入らないように外へ押し出す
function pushOutOfHouse(p, margin = 0.45) {
  const x0 = HOUSE.x0 - margin, x1 = HOUSE.x1 + margin, z0 = HOUSE.z0 - margin, z1 = HOUSE.z1 + margin;
  if (p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1) {
    const d = [p.x - x0, x1 - p.x, p.z - z0, z1 - p.z];
    const m = Math.min(...d);
    if (m === d[0]) p.x = x0; else if (m === d[1]) p.x = x1; else if (m === d[2]) p.z = z0; else p.z = z1;
  }
  p.x = clamp(p.x, BOUNDS.x0, BOUNDS.x1);
  p.z = clamp(p.z, BOUNDS.z0, BOUNDS.z1);
}

// 前方にいて、指定の距離以内か
function inFront(p, target, range, minDot = 0.42) {
  const dx = target.x - p.x;
  const dz = target.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d > range) return false;
  if (d < 0.2) return true;
  const f = fwd(p.yaw);
  return (f.x * dx + f.z * dz) / d >= minDot;
}

// =====================================================================
// 部屋
// =====================================================================
const rooms = new Map();

function makeRoom(code) {
  const room = { code, players: new Map(), phase: 'lobby', time: 0, parts: makeParts(), saw: 0, tools: new Map(), seq: 1 };
  spawnDummies(room);
  return room;
}

function newStats() {
  return { used: 0, work: 0, bonks: 0, faints: 0, thrown: 0 };
}

function spawnPos(i) {
  const a = i * 1.7 + 0.4;
  return { x: Math.sin(a) * 1.8, z: 5.2 + Math.cos(a) * 0.9 };
}

// 人がいない「ただの道具」（1人で練習するとき用。顔はない）
function spawnDummies(room) {
  TOOL_TYPES.forEach((type, i) => newTool(room, type, null, RACK.x - 0.7 + i * 0.7, RACK.z, Math.PI));
}

function newTool(room, type, owner, x, z, yaw) {
  const t = {
    id: 't' + room.seq++, type, owner, heldBy: null,
    state: type === 'ladder' ? 'stand' : 'lying',
    x, y: 0, z, yaw, vx: 0, vy: 0, vz: 0, dizzy: 0, lastUse: 0, thrower: null,
  };
  pushOutOfHouse(t, 0.35);
  room.tools.set(t.id, t);
  return t;
}

function emitRoster(room) {
  io.to(room.code).emit('roster', [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color })));
}

function layoutOf(room) {
  return room.parts.map((p) => ({ id: p.id, name: p.name, nails: p.nails.map((n) => [n.x, n.y, n.z]) }));
}

function occupied(room, t) {
  for (const p of room.players.values()) if (p.onLadder === t.id) return true;
  return false;
}

function fall(room, p) {
  p.onLadder = null;
  p.stun = Math.max(p.stun, 1.5);
  io.to(room.code).emit('fall', { id: p.id });
}

function dropTool(room, p) {
  const t = room.tools.get(p.holding);
  p.holding = null;
  if (!t) return;
  const f = fwd(p.yaw);
  t.heldBy = null;
  t.x = p.x + f.x * 0.75;
  t.z = p.z + f.z * 0.75;
  t.y = 0;
  t.yaw = p.yaw;
  t.state = t.type === 'ladder' ? 'stand' : 'lying';
  pushOutOfHouse(t, 0.35);
}

function stunPlayer(room, p, sec) {
  p.stun = Math.max(p.stun, sec);
  if (p.holding) dropTool(room, p); // 殴られたら持っている道具を落とす
  if (p.onLadder) fall(room, p);
}

// 道具から人間に戻す
function revertTool(room, t) {
  if (t.heldBy) {
    const h = room.players.get(t.heldBy);
    if (h) h.holding = null;
  }
  for (const p of room.players.values()) if (p.onLadder === t.id) fall(room, p);
  room.tools.delete(t.id);
  const o = t.owner && room.players.get(t.owner);
  if (!o) return;
  o.toolId = null;
  const pos = { x: t.x, z: t.z };
  pushOutOfHouse(pos);
  o.x = pos.x;
  o.z = pos.z;
  io.to(o.id).emit('teleport', pos);
  io.to(room.code).emit('revert', { id: o.id });
}

function addDizzy(room, t, amount) {
  t.lastUse = Date.now();
  if (!t.owner) return;
  t.dizzy = Math.min(100, t.dizzy + amount);
  if (t.dizzy >= 100) {
    const o = room.players.get(t.owner);
    revertTool(room, t);
    if (o) {
      o.stun = 2.0;
      o.noTransform = 3;
      o.stats.faints++;
      io.to(room.code).emit('faint', { id: o.id, name: o.name });
    }
  }
}

function progressOf(room) {
  const sum = room.parts.reduce((s, p) => {
    const nails = p.nails.reduce((a, n) => a + Math.min(n.hits, NAIL_HITS), 0) / (p.nails.length * NAIL_HITS);
    return s + (p.cut ? 0.3 : 0) + 0.7 * nails;
  }, 0);
  return sum / room.parts.length;
}

function startRound(room) {
  for (const t of [...room.tools.values()]) if (t.owner) revertTool(room, t);
  room.tools.clear();
  room.parts = makeParts();
  room.saw = 0;
  room.time = 0;
  room.phase = 'play';
  if (room.players.size === 1) spawnDummies(room);
  let i = 0;
  for (const p of room.players.values()) {
    Object.assign(p, { holding: null, onLadder: null, stun: 0, noTransform: 0, toolId: null, stats: newStats() });
    const s = spawnPos(i++);
    p.x = s.x;
    p.z = s.z;
    io.to(p.id).emit('teleport', s);
  }
  io.to(room.code).emit('start', { time: ROUND_TIME, solo: room.players.size === 1 });
}

function finish(room, success) {
  if (room.phase !== 'play') return;
  const prog = progressOf(room);
  const stars = success || prog >= 0.999 ? 3 : prog >= 0.6 ? 2 : 1;
  const msg = stars === 3 ? '嵐に耐えた！ 家が完成！' : stars === 2 ? '半壊…なんとか住めそう' : '家が吹き飛んだ…';
  const players = [...room.players.values()];
  const awards = [];
  const top = (key, title) => {
    if (!players.length) return;
    const m = players.reduce((a, b) => (b.stats[key] > a.stats[key] ? b : a));
    if (m.stats[key] > 0) awards.push({ title, name: m.name, n: m.stats[key] });
  };
  top('used', '一番使い倒された道具');
  top('work', '一番働いた大工');
  top('bonks', '一番仲間を殴った人');
  top('faints', '一番目を回した道具');
  top('thrown', '一番投げられた道具');
  io.to(room.code).emit('result', {
    stars, msg, success, progress: Math.round(prog * 100), time: Math.round(room.time), awards,
  });
  // ロビーに戻す（家はそのまま残す）
  for (const t of [...room.tools.values()]) if (t.owner) revertTool(room, t);
  room.tools.clear();
  for (const p of players) { p.holding = null; p.onLadder = null; }
  spawnDummies(room);
  room.phase = 'lobby';
}

// =====================================================================
// 毎フレームの更新
// =====================================================================
function stepFlying(room, t, dt) {
  const steps = 2;
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    const px = t.x;
    const pz = t.z;
    t.vy += GRAVITY * h;
    t.x += t.vx * h;
    t.y += t.vy * h;
    t.z += t.vz * h;
    // 家の骨組みに当たったら跳ね返る
    if (t.x > HOUSE.x0 - 0.1 && t.x < HOUSE.x1 + 0.1 && t.z > HOUSE.z0 - 0.1 && t.z < HOUSE.z1 + 0.1 && t.y < HOUSE.h) {
      t.x = px;
      t.z = pz;
      t.vx *= -0.3;
      t.vz *= -0.3;
    }
    if (t.x < BOUNDS.x0 || t.x > BOUNDS.x1) { t.x = clamp(t.x, BOUNDS.x0, BOUNDS.x1); t.vx *= -0.3; }
    if (t.z < BOUNDS.z0 || t.z > BOUNDS.z1) { t.z = clamp(t.z, BOUNDS.z0, BOUNDS.z1); t.vz *= -0.3; }
    // 人に当たる
    for (const p of room.players.values()) {
      if (p.toolId || p.id === t.thrower || p.id === t.owner || p.stun > 0) continue;
      if (t.y < 1.9 && Math.hypot(p.x - t.x, p.z - t.z) < 0.6) {
        stunPlayer(room, p, 1.5);
        const thrower = room.players.get(t.thrower);
        if (thrower) thrower.stats.bonks++;
        io.to(room.code).emit('bonk', { victim: p.id, toolId: t.id, x: r2(p.x), z: r2(p.z) });
        t.vx *= 0.3;
        t.vz *= 0.3;
        addDizzy(room, t, DIZZY.bonk);
        if (!room.tools.has(t.id)) return;
      }
    }
    if (t.y <= 0) {
      t.y = 0;
      t.vx = t.vy = t.vz = 0;
      t.state = 'lying'; // 投げたはしごは倒れる
      t.thrower = null;
      pushOutOfHouse(t, 0.35);
      io.to(room.code).emit('land', { toolId: t.id, x: r2(t.x), z: r2(t.z) });
      addDizzy(room, t, DIZZY.land);
      return;
    }
  }
}

function update(room, dt) {
  const now = Date.now();
  for (const p of room.players.values()) {
    p.stun = Math.max(0, p.stun - dt);
    p.noTransform = Math.max(0, p.noTransform - dt);
  }
  // はしごに乗っている人
  for (const p of room.players.values()) {
    if (!p.onLadder) continue;
    const lt = room.tools.get(p.onLadder);
    if (!lt || lt.state !== 'stand' || lt.heldBy) { fall(room, p); continue; }
    p.x = lt.x;
    p.z = lt.z;
    addDizzy(room, lt, DIZZY.climbPerSec * dt);
  }
  // 道具
  for (const t of [...room.tools.values()]) {
    if (!room.tools.has(t.id)) continue;
    if (t.heldBy) {
      const h = room.players.get(t.heldBy);
      if (!h) {
        t.heldBy = null;
        t.state = t.type === 'ladder' ? 'stand' : 'lying';
        t.y = 0;
      } else {
        const f = fwd(h.yaw);
        const rt = right(h.yaw);
        t.x = h.x + f.x * 0.45 + rt.x * 0.3;
        t.z = h.z + f.z * 0.45 + rt.z * 0.3;
        t.y = h.onLadder ? 2.4 : 1.0;
        t.yaw = h.yaw;
      }
    } else if (t.state === 'flying') {
      stepFlying(room, t, dt);
      if (!room.tools.has(t.id)) continue;
    }
    if (now - t.lastUse > 1500 && !occupied(room, t)) t.dizzy = Math.max(0, t.dizzy - 7 * dt);
    if (t.owner) {
      const o = room.players.get(t.owner);
      if (o) { o.x = t.x; o.z = t.z; }
    }
  }
  if (room.phase === 'play') {
    room.time += dt;
    if (room.time >= ROUND_TIME) finish(room, false);
  }
}

function broadcast(room) {
  const nextIdx = room.parts.findIndex((p) => !p.cut);
  io.to(room.code).emit('state', {
    ph: room.phase,
    tm: Math.round(Math.max(0, ROUND_TIME - room.time) * 10) / 10,
    p: [...room.players.values()].map((p) => ({
      i: p.id, x: r2(p.x), z: r2(p.z), yw: r2(p.yaw), tl: p.toolId, ho: p.holding, lad: p.onLadder,
      st: p.stun > 0 ? 1 : 0, v: r2(p.spd),
    })),
    t: [...room.tools.values()].map((t) => ({
      i: t.id, ty: t.type, o: t.owner, h: t.heldBy, s: t.state,
      x: r2(t.x), y: r2(t.y), z: r2(t.z), yw: r2(t.yaw), dz: Math.round(t.dizzy),
    })),
    pa: room.parts.map((p) => ({ c: p.cut ? 1 : 0, d: p.done ? 1 : 0, n: p.nails.map((n) => n.hits) })),
    sw: room.saw,
    nx: nextIdx,
    pr: Math.round(progressOf(room) * 100),
  });
}

const TICK = 50;
setInterval(() => {
  for (const room of rooms.values()) {
    update(room, TICK / 1000);
    broadcast(room);
  }
}, TICK);

// =====================================================================
// 通信
// =====================================================================
io.on('connection', (socket) => {
  let room = null;
  let me = null;
  const isHuman = () => me && !me.toolId;

  socket.on('join', (d, ack) => {
    if (room) return;
    const reply = typeof ack === 'function' ? ack : () => {};
    const name = String((d && d.name) || '').trim().slice(0, 10) || '大工';
    const color = d && COLOR_RE.test(d.color) ? d.color : '#e74c3c';
    let code = String((d && d.code) || '').replace(/\D/g, '').slice(0, 4);
    if (d && d.create) {
      do code = String(Math.floor(1000 + Math.random() * 9000)); while (rooms.has(code));
      rooms.set(code, makeRoom(code));
    }
    const r = rooms.get(code);
    if (!r) return reply({ ok: false, error: 'その合言葉の部屋は見つかりません' });
    if (r.players.size >= 4) return reply({ ok: false, error: '満員です（最大4人）' });
    room = r;
    const s = spawnPos(r.players.size);
    me = {
      id: socket.id, name, color, x: s.x, z: s.z, yaw: 0, spd: 0,
      toolId: null, holding: null, onLadder: null, stun: 0, noTransform: 0, useCd: 0, stats: newStats(),
    };
    r.players.set(socket.id, me);
    socket.join(code);
    reply({ ok: true, id: socket.id, code, spawn: s, phase: r.phase, roundTime: ROUND_TIME });
    socket.emit('layout', { parts: layoutOf(r), sawStrokes: SAW_STROKES, nailHits: NAIL_HITS });
    emitRoster(r);
  });

  socket.on('pos', (d) => {
    if (!me || !d) return;
    me.yaw = num(d.yaw, me.yaw);
    me.spd = clamp(num(d.v, 0), 0, 10);
    if (me.toolId || me.onLadder) return; // 道具中・はしごの上はサーバーが位置を決める
    me.x = clamp(num(d.x, me.x), BOUNDS.x0, BOUNDS.x1);
    me.z = clamp(num(d.z, me.z), BOUNDS.z0, BOUNDS.z1);
  });

  socket.on('transform', (d) => {
    if (!room || !me) return;
    const type = d && d.type;
    if (type === 'human') {
      const t = me.toolId && room.tools.get(me.toolId);
      if (t) revertTool(room, t);
      return;
    }
    if (!TOOL_TYPES.includes(type) || me.toolId || me.stun > 0 || me.onLadder) return;
    if (me.noTransform > 0) return socket.emit('hint', { text: 'まだ目が回っている…' });
    if ([...room.tools.values()].some((t) => t.owner && t.type === type)) {
      return socket.emit('hint', { text: `${TOOL_NAMES[type]}には、もう誰かがなっている` });
    }
    if (me.holding) dropTool(room, me);
    const t = newTool(room, type, me.id, me.x, me.z, me.yaw);
    me.toolId = t.id;
    io.to(room.code).emit('transform', { id: me.id, type, toolId: t.id });
  });

  socket.on('pickup', () => {
    if (!room || !isHuman() || me.holding || me.stun > 0 || me.onLadder) return;
    let best = null;
    let bd = 1.6;
    for (const t of room.tools.values()) {
      if (t.heldBy || t.state === 'flying' || t.owner === me.id || occupied(room, t)) continue;
      const d = dist2d(t, me);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return;
    best.heldBy = me.id;
    best.state = 'held';
    me.holding = best.id;
    io.to(room.code).emit('pickup', { id: me.id, toolId: best.id });
  });

  socket.on('drop', () => {
    if (!room || !isHuman() || !me.holding) return;
    dropTool(room, me);
  });

  socket.on('throw', () => {
    if (!room || !isHuman() || !me.holding || me.stun > 0) return;
    const t = room.tools.get(me.holding);
    me.holding = null;
    if (!t) return;
    const f = fwd(me.yaw);
    Object.assign(t, {
      heldBy: null, state: 'flying', thrower: me.id,
      x: me.x + f.x * 0.6, y: me.onLadder ? 2.6 : 1.3, z: me.z + f.z * 0.6,
      vx: f.x * 9, vy: 4.5, vz: f.z * 9,
    });
    const o = t.owner && room.players.get(t.owner);
    if (o) o.stats.thrown++;
    addDizzy(room, t, DIZZY.throw);
    io.to(room.code).emit('throw', { id: me.id, toolId: t.id });
  });

  socket.on('climb', () => {
    if (!room || !isHuman() || me.stun > 0) return;
    if (me.onLadder) { me.onLadder = null; io.to(room.code).emit('climb', { id: me.id, up: false }); return; }
    const held = me.holding && room.tools.get(me.holding);
    if (held && held.type === 'ladder') return;
    let best = null;
    let bd = 1.3;
    for (const t of room.tools.values()) {
      if (t.type !== 'ladder' || t.state !== 'stand' || t.heldBy || occupied(room, t)) continue;
      const d = dist2d(t, me);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return;
    me.onLadder = best.id;
    me.x = best.x;
    me.z = best.z;
    io.to(room.code).emit('climb', { id: me.id, up: true, toolId: best.id });
  });

  socket.on('use', () => {
    if (!room || !isHuman() || !me.holding || me.stun > 0) return;
    const t = room.tools.get(me.holding);
    if (!t) return;
    const now = Date.now();
    if (now < me.useCd) return;
    me.useCd = now + (t.type === 'saw' ? 250 : t.type === 'ladder' ? 700 : 450);
    const owner = t.owner && room.players.get(t.owner);
    if (owner) owner.stats.used++;
    const res = { id: me.id, toolId: t.id, type: t.type, hit: null };
    const playing = room.phase === 'play';

    if (t.type === 'hammer') {
      // 釘を探す（はしごの上なら高いところに届く）
      const lo = me.onLadder ? 1.0 : 0;
      const hi = me.onLadder ? 3.1 : 1.75;
      let best = null;
      let bd = 1.7;
      if (playing) {
        room.parts.forEach((part) => {
          if (!part.cut || part.done) return;
          for (const n of part.nails) {
            if (n.hits >= NAIL_HITS || n.y < lo || n.y > hi || !inFront(me, n, bd, 0.3)) continue;
            bd = dist2d(me, n);
            best = { part, n };
          }
        });
      }
      if (best) {
        best.n.hits++;
        me.stats.work++;
        Object.assign(res, { hit: 'nail', x: best.n.x, y: best.n.y, z: best.n.z });
        if (best.part.nails.every((n) => n.hits >= NAIL_HITS)) {
          best.part.done = true;
          io.to(room.code).emit('partDone', { id: best.part.id, name: best.part.name });
        }
        addDizzy(room, t, DIZZY.nail);
      } else {
        const victim = [...room.players.values()].find((p) => p !== me && !p.toolId && p.stun <= 0 && inFront(me, p, 1.3));
        if (victim) {
          stunPlayer(room, victim, 1.2);
          me.stats.bonks++;
          Object.assign(res, { hit: 'bonk', victim: victim.id });
          addDizzy(room, t, DIZZY.bonk);
        } else {
          addDizzy(room, t, DIZZY.miss);
        }
      }
    } else if (t.type === 'saw') {
      const part = room.parts.find((p) => !p.cut);
      if (playing && part && dist2d(me, SAWHORSE) < 2.0) {
        room.saw++;
        me.stats.work++;
        res.hit = 'saw';
        if (room.saw >= SAW_STROKES) {
          room.saw = 0;
          part.cut = true;
          io.to(room.code).emit('board', { id: part.id, name: part.name });
        }
        addDizzy(room, t, DIZZY.saw);
      } else {
        addDizzy(room, t, DIZZY.sawMiss);
      }
    } else {
      // はしごを振り回す（広く当たる）
      const victim = [...room.players.values()].find((p) => p !== me && !p.toolId && p.stun <= 0 && inFront(me, p, 2.2, 0.2));
      if (victim) {
        stunPlayer(room, victim, 1.5);
        me.stats.bonks++;
        Object.assign(res, { hit: 'bonk', victim: victim.id });
      }
      addDizzy(room, t, DIZZY.ladderSwing);
    }
    io.to(room.code).emit('swing', res);
    if (playing && room.parts.every((p) => p.done)) finish(room, true);
  });

  socket.on('emote', (d) => {
    if (!room || !me) return;
    const i = Math.floor(num(d && d.i, 0));
    if (i < 0 || i >= EMOTES.length) return;
    io.to(room.code).emit('emote', { id: me.id, text: EMOTES[i] });
  });

  socket.on('start', () => {
    if (!room || room.phase !== 'lobby') return;
    startRound(room);
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (me.holding) dropTool(room, me);
    if (me.onLadder) me.onLadder = null;
    const t = me.toolId && room.tools.get(me.toolId);
    if (t) {
      t.owner = null; // 抜けた人の道具は、ただの道具として残す
      t.dizzy = 0;
    }
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else emitRoster(room);
  });
});

server.listen(PORT, () => {
  console.log(`おれが金づちだ（仮） → http://localhost:${PORT}`);
});
