'use strict';
/**
 * おじいちゃん、起こさないで（仮） プロトタイプサーバー
 *
 * 起動:  npm install → npm start → http://localhost:3000
 *
 * 役割分担
 *  - プレイヤーの移動 … 各クライアントが計算して位置を送る（操作の反応を良くするため）
 *  - 布団の物理・眠りゲージ・寝言・薄目・NPC・判定 … すべてサーバーが計算して配信する
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
// マップ
// 記号: # 壁 / . 畳 / w 板の間 / d 土間 / g 庭 / c きしむ床 / s 階段（上がり框）
//       F ふすま / v 花瓶 / S 布団の初期位置 / P ポチ / K ケンジおじさん
//       G ゴール（主役席） / C 休憩所（チェックポイント）
// ロビー専用: O 押し入れ / T テレビ / A ちゃぶ台（アルバム） / H 黒電話 / E 玄関 / Z じいちゃんの布団
// =====================================================================
const R = (s, n) => s.repeat(n);

const LOBBY_ROWS = [
  '############',
  '#OO..TT....#',
  '#..........#',
  '#....ZZ....#',
  '#..........#',
  '#..A.......#',
  '#..........#',
  '#H........E#',
  '#..........#',
  '############',
];

const CHAPTERS = {
  prologue: {
    name: '序章「主役は、昼寝中」',
    parTime: 90,
    startGauge: 76, // 序章は寝言がすぐ聞けるように少し浅めから
    futonAngle: 0,
    rows: [
      '##############',
      '#............#',
      '#.v........v.#',
      '#............#',
      '#....GGGG....#',
      '#....GGGG....#',
      '#............#',
      '####FFFFFF####',
      '#wwccwwwwccww#',
      '#wwwwwSwwwwww#',
      '#gggggggggggg#',
      '#gggggggggPgg#',
      '##############',
    ],
    talks: [
      '…ミヨコ…',
      '…そこの段差…気ぃつけえ…',
      '…ばあさん…茶ぁ…',
      '…灯台が…見えるか…',
      '…すまん…遅うなる…',
    ],
    keyLine: '…ミヨコ…待っとってくれ…',
    kenjiPath: null,
  },
  ch1: {
    name: '1章「家の中は戦場」',
    parTime: 300,
    startGauge: 92,
    futonAngle: 0,
    rows: [
      R('#', 32),
      '#.........#' + R('w', 17) + '####',
      '#..v......#' + R('w', 7) + 'K' + R('w', 9) + '####',
      '#.........' + R('#', 6) + 'www' + R('#', 13),
      '#.........F' + R('w', 19) + '##',
      '#.........F' + 'wwwcccwwwccwwww' + 'wwww' + '##',
      '#...S.....' + R('#', 16) + 'wCCw' + '##',
      '#.........' + R('#', 16) + 'wCCw' + '##',
      '#..v...v..' + R('#', 16) + '#ww#' + '##',
      R('#', 26) + '#ww#' + '##',
      R('#', 26) + '#cc#' + '##',
      R('#', 26) + '#ww#' + '##',
      R('#', 26) + '#ww#' + '##',
      R('#', 18) + R('s', 12) + '##',
      R('#', 18) + R('s', 12) + '##',
      R('#', 18) + 'v' + R('d', 10) + 'v' + '##',
      R('#', 18) + R('d', 12) + '##',
      R('#', 20) + 'dddd' + R('#', 6) + '##',
      '#' + R('g', 30) + '#',
      '#' + 'gggGGG' + R('g', 7) + 'P' + R('g', 16) + '#',
      '#' + 'gggGGG' + R('g', 24) + '#',
      R('#', 32),
    ],
    talks: [
      '親方…カンナはまだ早いっす…',
      'この柱は…百年もつ…',
      '家を建てたら…あの人を…',
      '…ミヨコさんの弁当…うまい…',
      '一人前に…なったら…',
    ],
    keyLine: '…一人前になったら…言うんじゃ…',
    kenjiPath: [[18.5, 2.5], [17.5, 3.5], [17.5, 4.5], [23.5, 4.5], [17.5, 4.5], [17.5, 3.5], [12.5, 1.5], [18.5, 1.5]],
  },
};
const CHAPTER_ORDER = ['prologue', 'ch1'];

const KENJI_LINES = ['おーい！何運んでんだ？', 'じいさん寝てんのか！？', '手伝おうかぁ！？', '今日の寿司、特上だぞぉ！', 'ガハハハハ！'];
const COVERS = ['hana', 'stripe', 'karakusa', 'gold'];

// マップの行の長さがそろっているか起動時に確認する
for (const [id, rows] of [['lobby', LOBBY_ROWS], ...CHAPTER_ORDER.map((k) => [k, CHAPTERS[k].rows])]) {
  const w = rows[0].length;
  rows.forEach((r, i) => {
    if (r.length !== w) throw new Error(`マップ ${id} の ${i} 行目の長さが ${r.length}（${w} のはず）`);
  });
}

// =====================================================================
// マップ処理
// =====================================================================
const SOLID = new Set(['#', 'O', 'T', 'A', 'H', 'E', 'Z']);

function parseMap(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const m = { rows, w, h, start: null, pochi: null, kenji: null, vases: [], doors: [], doorOf: new Map() };
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      const ch = rows[z][x];
      const c = { x: x + 0.5, z: z + 0.5 };
      if (ch === 'S') m.start = c;
      else if (ch === 'P') m.pochi = c;
      else if (ch === 'K') m.kenji = c;
      else if (ch === 'v') m.vases.push({ x: c.x, z: c.z, broken: false });
    }
  }
  // つながったふすまを1枚の扉としてまとめる
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (rows[z][x] !== 'F' || m.doorOf.has(x + ',' + z)) continue;
      const id = m.doors.length;
      const tiles = [];
      const stack = [[x, z]];
      m.doorOf.set(x + ',' + z, id);
      while (stack.length) {
        const [cx, cz] = stack.pop();
        tiles.push([cx, cz]);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (tileAt(m, nx, nz) === 'F' && !m.doorOf.has(nx + ',' + nz)) {
            m.doorOf.set(nx + ',' + nz, id);
            stack.push([nx, nz]);
          }
        }
      }
      m.doors.push(tiles);
    }
  }
  return m;
}

function tileAt(m, x, z) {
  if (x < 0 || z < 0 || x >= m.w || z >= m.h) return '#';
  return m.rows[z][x];
}

function isSolid(m, doorsOpen, x, z) {
  const ch = tileAt(m, x, z);
  if (SOLID.has(ch)) return true;
  if (ch === 'F') return !doorsOpen[m.doorOf.get(x + ',' + z)];
  return false;
}

// 円とタイルの当たり判定。p を押し出し、当たった方向の合計を返す
function collideCircle(m, doorsOpen, p, r) {
  let hit = null;
  const minX = Math.floor(p.x - r);
  const maxX = Math.floor(p.x + r);
  const minZ = Math.floor(p.z - r);
  const maxZ = Math.floor(p.z + r);
  for (let tz = minZ; tz <= maxZ; tz++) {
    for (let tx = minX; tx <= maxX; tx++) {
      if (!isSolid(m, doorsOpen, tx, tz)) continue;
      const cx = Math.max(tx, Math.min(p.x, tx + 1));
      const cz = Math.max(tz, Math.min(p.z, tz + 1));
      const dx = p.x - cx;
      const dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      let nx;
      let nz;
      let pen;
      const d = Math.sqrt(d2);
      if (d < 1e-6) {
        const left = p.x - tx;
        const right = tx + 1 - p.x;
        const up = p.z - tz;
        const down = tz + 1 - p.z;
        const mn = Math.min(left, right, up, down);
        if (mn === left) { nx = -1; nz = 0; pen = left + r; }
        else if (mn === right) { nx = 1; nz = 0; pen = right + r; }
        else if (mn === up) { nx = 0; nz = -1; pen = up + r; }
        else { nx = 0; nz = 1; pen = down + r; }
      } else {
        nx = dx / d;
        nz = dz / d;
        pen = r - d;
      }
      p.x += nx * pen;
      p.z += nz * pen;
      if (!hit) hit = { nx: 0, nz: 0 };
      hit.nx += nx;
      hit.nz += nz;
    }
  }
  return hit;
}

// =====================================================================
// 布団（長さ2m × 幅1m。ローカルx軸が長さ方向、-x側が頭）
// =====================================================================
const CORNERS = [[1, 0.5], [1, -0.5], [-1, -0.5], [-1, 0.5]];
const FUTON_CIRCLES = [-0.52, 0, 0.52];
const FUTON_R = 0.47;

function cornerPos(f, i) {
  const [lx, lz] = CORNERS[i];
  const c = Math.cos(f.a);
  const s = Math.sin(f.a);
  return { x: f.x + lx * c - lz * s, z: f.z + lx * s + lz * c };
}

function isLifted(f) {
  let n = 0;
  for (let i = 0; i < 4; i++) if (f.holders[i] && f.h[i] > 0.5) n++;
  return n >= 2;
}

const approach = (v, t, step) => (v < t ? Math.min(t, v + step) : Math.max(t, v - step));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// =====================================================================
// 部屋
// =====================================================================
const rooms = new Map();

function makeRoom(code) {
  return { code, players: new Map(), mode: 'lobby', cover: 'hana', game: null };
}

function newStats() {
  return { shake: 0, hold: 0, broken: 0, talks: 0, caught: 0 };
}

function lobbySpawn(i) {
  return { x: 4.6 + i * 0.9, z: 8.4 };
}

function spawnAround(g, i) {
  const f = g.futon;
  const offs = [[0, 1.15], [0, -1.15], [1.7, 0], [-1.7, 0], [1.7, 1.1], [-1.7, -1.1]];
  const c = Math.cos(f.a);
  const s = Math.sin(f.a);
  for (let k = 0; k < offs.length; k++) {
    const [ox, oz] = offs[(i + k) % offs.length];
    const x = f.x + ox * c - oz * s;
    const z = f.z + ox * s + oz * c;
    if (!isSolid(g.map, g.doorsOpen, Math.floor(x), Math.floor(z))) return { x, z };
  }
  return { x: f.x, z: f.z };
}

function emitRoster(room) {
  const list = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, skin: p.skin }));
  io.to(room.code).emit('roster', list);
}

function modePayload(room, spawn) {
  if (room.mode === 'play' && room.game) {
    const g = room.game;
    const ch = CHAPTERS[g.chapterId];
    return {
      mode: 'play',
      chapterId: g.chapterId,
      chapterName: ch.name,
      rows: g.map.rows,
      spawn,
      doorsOpen: g.doorsOpen.slice(),
      vases: g.vases.map((v) => v.broken),
      futon: { x: g.futon.x, z: g.futon.z, a: g.futon.a },
      cover: room.cover,
      talkTotal: ch.talks.length,
      collected: g.collected.length,
    };
  }
  return { mode: 'lobby', rows: LOBBY_ROWS, spawn, cover: room.cover };
}

function burst(room, kind, amount, x, z, text) {
  const g = room.game;
  if (g && amount > 0) {
    g.gauge = Math.max(0, g.gauge - amount);
    g.lastBurst = g.time;
  }
  io.to(room.code).emit('burst', { kind, text, x: r2(x), z: r2(z) });
}

function startChapter(room, id) {
  const ch = CHAPTERS[id];
  const map = parseMap(ch.rows);
  const a = ch.futonAngle || 0;
  const g = {
    chapterId: id,
    map,
    doorsOpen: map.doors.map(() => false),
    vases: map.vases.map((v) => ({ ...v })),
    futon: {
      x: map.start.x, z: map.start.z, a,
      vx: 0, vz: 0, w: 0, pvx: 0, pvz: 0, acc: 0,
      h: [0, 0, 0, 0],
      holders: [null, null, null, null],
      tileKey: '',
    },
    gauge: ch.startGauge || 100,
    band: (ch.startGauge || 100) >= 70 ? 'deep' : 'light',
    eyes: 'closed',
    eyeT: 0,
    eyeNext: 6,
    caught: new Set(),
    talkT: 3,
    talkIdx: 0,
    collected: [],
    safe: 0,
    broken: 0,
    wakes: 0,
    time: 0,
    phase: 'play',
    phaseT: 0,
    checkpoint: { x: map.start.x, z: map.start.z, a },
    cpReached: false,
    lastBurst: -10,
    pochi: map.pochi ? { x: map.pochi.x, z: map.pochi.z, a: 0, calm: id === 'prologue' ? 10 : 0, barkT: 1.5, wanderA: 0, wanderT: 0, st: 'idle' } : null,
    kenji: map.kenji ? { x: map.kenji.x, z: map.kenji.z, a: 0, wp: 0, whisper: 0, shoutT: 2 } : null,
  };
  room.game = g;
  room.mode = 'play';
  let i = 0;
  for (const p of room.players.values()) {
    p.holding = -1;
    p.lifting = false;
    p.stats = newStats();
    const s = spawnAround(g, i++);
    p.x = s.x;
    p.z = s.z;
    p.tileKey = Math.floor(s.x) + ',' + Math.floor(s.z);
    p.quietUntil = 1.0;
    io.to(p.id).emit('mode', modePayload(room, s));
  }
}

function backToLobby(room) {
  room.mode = 'lobby';
  room.game = null;
  let i = 0;
  for (const p of room.players.values()) {
    p.holding = -1;
    p.lifting = false;
    const s = lobbySpawn(i++);
    p.x = s.x;
    p.z = s.z;
    io.to(p.id).emit('mode', modePayload(room, s));
  }
}

function releaseHold(room, p) {
  const g = room.game;
  const i = p.holding;
  p.holding = -1;
  p.lifting = false;
  if (!g || i < 0) return;
  const f = g.futon;
  const wasLifted = isLifted(f);
  const hi = f.h[i];
  f.holders[i] = null;
  if (wasLifted && hi > 0.5) burst(room, 'drop', 4, f.x, f.z, 'ドスン！');
}

function resetToCheckpoint(room) {
  const g = room.game;
  const f = g.futon;
  const cp = g.checkpoint;
  Object.assign(f, {
    x: cp.x, z: cp.z, a: cp.a, vx: 0, vz: 0, w: 0, pvx: 0, pvz: 0, acc: 0,
    h: [0, 0, 0, 0], holders: [null, null, null, null], tileKey: '',
  });
  g.gauge = 65;
  g.band = 'light';
  g.eyes = 'closed';
  g.eyeNext = 6;
  g.phase = 'play';
  g.talkT = Math.max(g.talkT, 3);
  g.lastBurst = g.time;
  if (g.pochi) g.pochi.calm = Math.max(g.pochi.calm, 5);
  let i = 0;
  for (const p of room.players.values()) {
    p.holding = -1;
    p.lifting = false;
    const s = spawnAround(g, i++);
    p.x = s.x;
    p.z = s.z;
    p.tileKey = Math.floor(s.x) + ',' + Math.floor(s.z);
    p.quietUntil = g.time + 1.0;
    io.to(p.id).emit('teleport', s);
  }
}

function clearChapter(room) {
  const g = room.game;
  const ch = CHAPTERS[g.chapterId];
  g.phase = 'clear';
  const players = [...room.players.values()];
  const sleep = Math.round(g.gauge);
  const t = g.time;
  const timeBonus = Math.max(0, Math.round(ch.parTime - t));
  const score = sleep + timeBonus + g.collected.length * 20 + g.safe * 15 - g.broken * 10 - g.wakes * 30;
  const rank = score >= 200 ? 'S' : score >= 150 ? 'A' : score >= 100 ? 'B' : 'C';

  const awards = [];
  if (players.length >= 2) {
    const holders = players.filter((p) => p.stats.hold > 3);
    if (holders.length) {
      const best = holders.reduce((a, b) => (a.stats.shake / a.stats.hold <= b.stats.shake / b.stats.hold ? a : b));
      awards.push({ title: '一番揺らさなかった孫', name: best.name });
    }
    const top = (key, title) => {
      const m = players.reduce((a, b) => (b.stats[key] > a.stats[key] ? b : a));
      if (m.stats[key] > 0) awards.push({ title, name: m.name, n: m.stats[key] });
    };
    top('talks', '一番寝言を引き出した孫');
    top('broken', '一番物を壊した孫');
    top('caught', '一番バレた孫');
  }

  io.to(room.code).emit('clear', {
    chapterId: g.chapterId,
    chapterName: ch.name,
    sleep,
    time: Math.round(t),
    timeBonus,
    talks: g.collected.slice(),
    talkTexts: g.collected.map((i) => ch.talks[i]),
    talkTotal: ch.talks.length,
    safe: g.safe,
    broken: g.broken,
    wakes: g.wakes,
    score,
    rank,
    okozukai: Math.max(10, Math.floor(Math.max(0, score) / 2)),
    awards,
    keyLine: ch.keyLine,
  });
  backToLobby(room);
}

// =====================================================================
// ゲームの更新
// =====================================================================
function stepFuton(room, g, dt) {
  const f = g.futon;
  const holderList = [];
  for (let i = 0; i < 4; i++) {
    const p = f.holders[i] && room.players.get(f.holders[i]);
    if (p) holderList.push(p);
    else f.holders[i] = null;
  }
  const held = holderList.length;

  let Fx = 0;
  let Fz = 0;
  let T = 0;
  for (let i = 0; i < 4; i++) {
    const p = f.holders[i] && room.players.get(f.holders[i]);
    const target = p ? (p.lifting && held >= 2 ? 0.8 : 0.15) : 0;
    f.h[i] = approach(f.h[i], target, 1.8 * dt);
    if (!p) continue;
    // 持ち手（プレイヤー）と角をバネでつなぐ
    const c = cornerPos(f, i);
    const fx = (p.x - c.x) * 55;
    const fz = (p.z - c.z) * 55;
    Fx += fx;
    Fz += fz;
    T += (c.x - f.x) * fz - (c.z - f.z) * fx;
  }

  const heldH = [];
  for (let i = 0; i < 4; i++) if (f.holders[i]) heldH.push(f.h[i]);
  const lifted = isLifted(f);
  const lin = held === 0 ? 14 : lifted ? 3.5 : 7.5;
  const ang = lifted ? 4 : 8;
  const M = 8;
  const I = 3.3;

  f.pvx = f.vx;
  f.pvz = f.vz;
  f.vx += (Fx / M) * dt;
  f.vz += (Fz / M) * dt;
  f.w += (T / I) * dt;
  const dl = Math.exp(-lin * dt);
  f.vx *= dl;
  f.vz *= dl;
  f.w *= Math.exp(-ang * dt);
  const sp0 = Math.hypot(f.vx, f.vz);
  if (sp0 > 4) {
    f.vx *= 4 / sp0;
    f.vz *= 4 / sp0;
  }
  f.w = clamp(f.w, -3, 3);
  f.x += f.vx * dt;
  f.z += f.vz * dt;
  f.a += f.w * dt;

  // 壁との当たり判定（布団を3つの円で近似）
  let impact = 0;
  for (let it = 0; it < 2; it++) {
    for (const off of FUTON_CIRCLES) {
      const cx = f.x + Math.cos(f.a) * off;
      const cz = f.z + Math.sin(f.a) * off;
      const q = { x: cx, z: cz };
      const hit = collideCircle(g.map, g.doorsOpen, q, FUTON_R);
      if (!hit) continue;
      f.x += q.x - cx;
      f.z += q.z - cz;
      const n = Math.hypot(hit.nx, hit.nz) || 1;
      const nx = hit.nx / n;
      const nz = hit.nz / n;
      const vn = f.vx * nx + f.vz * nz;
      if (vn < 0) {
        f.vx -= nx * vn;
        f.vz -= nz * vn;
        impact = Math.max(impact, -vn);
      }
      f.w *= 0.7;
    }
  }

  const acc = Math.hypot(f.vx - f.pvx, f.vz - f.pvz) / dt;
  f.acc = f.acc * 0.6 + acc * 0.4;
  const spd = Math.hypot(f.vx, f.vz);

  // 揺れによる眠りの減少
  let shake = 0;
  if (lifted) shake += Math.max(0, f.acc - 2.5) * 0.12 * dt;
  else if (held > 0) shake += spd * 0.4 * dt + Math.max(0, f.acc - 4) * 0.05 * dt;
  if (heldH.length >= 2) shake += (Math.max(...heldH) - Math.min(...heldH)) * 6 * dt; // 傾き
  const tx = Math.floor(f.x);
  const tz = Math.floor(f.z);
  const tile = tileAt(g.map, tx, tz);
  if (tile === 's') shake += spd * (lifted ? 0.8 : 4) * dt; // 階段

  const key = tx + ',' + tz;
  if (key !== f.tileKey) {
    f.tileKey = key;
    if (tile === 'c' && !lifted && held > 0) burst(room, 'creak', 2, f.x, f.z, 'ギシッ');
  }
  if (impact > 0.35) burst(room, 'impact', Math.min(10, impact * 7), f.x, f.z, 'ガタン！');

  return { shake, lifted, spd, held, holderList, tile };
}

function updatePochi(room, g, dt) {
  const po = g.pochi;
  if (!po) return;
  const f = g.futon;
  const dx = f.x - po.x;
  const dz = f.z - po.z;
  const d = Math.hypot(dx, dz);
  let vx = 0;
  let vz = 0;
  if (po.calm > 0) {
    po.calm -= dt;
    po.st = 'sit';
  } else if (d < 6) {
    po.st = 'alert';
    if (d > 1.8) {
      vx = (dx / d) * 2.0;
      vz = (dz / d) * 2.0;
    }
    if (d < 4) {
      po.barkT -= dt;
      if (po.barkT <= 0) {
        po.barkT = 2.6;
        burst(room, 'bark', 5, po.x, po.z, 'ワン！ワン！');
      }
    }
  } else {
    po.st = 'walk';
    po.wanderT -= dt;
    if (po.wanderT <= 0) {
      po.wanderT = 1.5 + Math.random() * 2;
      po.wanderA = Math.random() * Math.PI * 2;
    }
    vx = Math.cos(po.wanderA) * 0.9;
    vz = Math.sin(po.wanderA) * 0.9;
  }
  po.x += vx * dt;
  po.z += vz * dt;
  const q = { x: po.x, z: po.z };
  collideCircle(g.map, g.doorsOpen, q, 0.28);
  po.x = q.x;
  po.z = q.z;
  if (vx || vz) po.a = Math.atan2(vx, vz);
}

function updateKenji(room, g, dt) {
  const k = g.kenji;
  if (!k) return;
  const pathPts = CHAPTERS[g.chapterId].kenjiPath;
  const [tx, tz] = pathPts[k.wp];
  const dx = tx - k.x;
  const dz = tz - k.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.08) {
    k.wp = (k.wp + 1) % pathPts.length;
  } else {
    const s = Math.min(1.1 * dt, d);
    k.x += (dx / d) * s;
    k.z += (dz / d) * s;
    k.a = Math.atan2(dx, dz);
  }
  if (k.whisper > 0) k.whisper -= dt;
  const fd = Math.hypot(g.futon.x - k.x, g.futon.z - k.z);
  if (k.whisper <= 0 && fd < 4.5) {
    k.shoutT -= dt;
    if (k.shoutT <= 0) {
      k.shoutT = 2.6;
      burst(room, 'kenji', 4, k.x, k.z, pick(KENJI_LINES));
    }
  } else {
    k.shoutT = Math.min(k.shoutT, 1.0);
  }
}

function updateGame(room, dt) {
  const g = room.game;
  if (g.phase === 'woke') {
    g.phaseT -= dt;
    if (g.phaseT <= 0) resetToCheckpoint(room);
    return;
  }
  if (g.phase !== 'play') return;
  g.time += dt;
  const players = [...room.players.values()];
  const ch = CHAPTERS[g.chapterId];

  const r = stepFuton(room, g, dt);
  let loss = r.shake;
  let gain = 0;
  for (const p of r.holderList) {
    p.stats.shake += r.shake / r.holderList.length;
    p.stats.hold += dt;
  }

  // プレイヤーの足音・きしむ床
  for (const p of players) {
    const tx = Math.floor(p.x);
    const tz = Math.floor(p.z);
    const tile = tileAt(g.map, tx, tz);
    const quiet = g.time < p.quietUntil;
    if (!quiet && p.spd > 0.3 && !p.frozen) loss += (p.sneak ? 0.04 : 0.22) * (tile === 'g' ? 0.5 : 1) * dt;
    const key = tx + ',' + tz;
    if (key !== p.tileKey) {
      p.tileKey = key;
      if (!quiet && tile === 'c') burst(room, 'creak', p.sneak ? 0.5 : 3, p.x, p.z, p.sneak ? 'きし…' : 'ギシッ！');
    }
  }

  // 花瓶
  const f = g.futon;
  for (const v of g.vases) {
    if (v.broken) continue;
    let by = null;
    for (const off of FUTON_CIRCLES) {
      const cx = f.x + Math.cos(f.a) * off;
      const cz = f.z + Math.sin(f.a) * off;
      if (Math.hypot(v.x - cx, v.z - cz) < FUTON_R + 0.2) by = 'futon';
    }
    for (const p of players) if (Math.hypot(v.x - p.x, v.z - p.z) < 0.5) by = p;
    if (by) {
      v.broken = true;
      g.broken++;
      if (by !== 'futon') by.stats.broken++;
      burst(room, 'vase', 6, v.x, v.z, 'ガシャーン！');
    }
  }

  updatePochi(room, g, dt);
  updateKenji(room, g, dt);

  // 回復（静かにしている・子守唄）
  const allStill = players.every((p) => p.spd < 0.25 || p.frozen);
  if (r.spd < 0.15 && allStill && g.time - g.lastBurst > 2) gain += 1.5 * dt;
  const hum = players.filter((p) => p.humming && p.spd < 0.5).length;
  if (hum > 0 && r.spd < 1.2) gain += 2.5 * (hum / players.length) * (hum === players.length ? 1.5 : 1) * dt;

  g.gauge = clamp(g.gauge - loss + gain, 0, 100);

  const nb = g.gauge >= 70 ? 'deep' : g.gauge >= 30 ? 'light' : 'half';
  if (nb !== g.band) {
    if (nb === 'light') g.talkT = Math.max(g.talkT, 2.5);
    g.band = nb;
  }

  // 寝言（浅い眠りのときだけ）
  if (g.band === 'light' && g.talkIdx < ch.talks.length) {
    g.talkT -= dt;
    if (g.talkT <= 0) {
      g.talkT = 7;
      const idx = g.talkIdx++;
      g.collected.push(idx);
      for (const p of r.holderList) p.stats.talks++;
      io.to(room.code).emit('talk', { idx, text: ch.talks[idx], n: g.collected.length, total: ch.talks.length });
    }
  }

  // 薄目イベント（半覚醒のときだけ）
  if (g.eyes === 'closed') {
    if (g.band === 'half') {
      g.eyeNext -= dt;
      if (g.eyeNext <= 0) {
        g.eyes = 'twitch';
        g.eyeT = 1.5;
        g.caught.clear();
      }
    } else {
      g.eyeNext = Math.max(g.eyeNext, 2.5);
    }
  } else if (g.eyes === 'twitch') {
    g.eyeT -= dt;
    if (g.eyeT <= 0) {
      g.eyes = 'open';
      g.eyeT = 2.5;
    }
  } else if (g.eyes === 'open') {
    for (const p of players) {
      if (!p.frozen && p.spd > 0.3 && !g.caught.has(p.id)) {
        g.caught.add(p.id);
        p.stats.caught++;
        g.gauge = Math.max(0, g.gauge - 10);
        g.lastBurst = g.time;
        io.to(room.code).emit('caught', { id: p.id, name: p.name });
      }
    }
    g.eyeT -= dt;
    if (g.eyeT <= 0) {
      if (g.caught.size === 0) {
        g.safe++;
        io.to(room.code).emit('safe', { n: g.safe });
      }
      g.eyes = 'closed';
      g.eyeNext = 5 + Math.random() * 4;
    }
  }

  // 起きてしまった
  if (g.gauge <= 0) {
    g.phase = 'woke';
    g.phaseT = 4.5;
    g.wakes++;
    g.eyes = 'open';
    for (const p of players) {
      p.holding = -1;
      p.lifting = false;
    }
    f.holders = [null, null, null, null];
    io.to(room.code).emit('woke');
    return;
  }

  // 休憩所（チェックポイント）
  if (r.tile === 'C' && !g.cpReached) {
    g.cpReached = true;
    g.checkpoint = { x: f.x, z: f.z, a: f.a };
    io.to(room.code).emit('checkpoint');
  }

  // ゴール：布団を下ろして止めたらクリア
  if (r.tile === 'G' && !r.lifted && r.spd < 0.3) clearChapter(room);
}

function playerEntry(p) {
  return {
    i: p.id, x: r2(p.x), z: r2(p.z), a: r2(p.a),
    f: p.frozen ? 1 : 0, ps: p.pose, s: p.sneak ? 1 : 0, h: p.humming ? 1 : 0,
    ho: p.holding, l: p.lifting ? 1 : 0, v: r2(p.spd),
  };
}

function broadcastState(room) {
  const ps = [...room.players.values()].map(playerEntry);
  if (room.mode !== 'play' || !room.game) {
    io.to(room.code).emit('state', { m: 'lobby', p: ps });
    return;
  }
  const g = room.game;
  const f = g.futon;
  io.to(room.code).emit('state', {
    m: 'play',
    t: r2(g.time),
    p: ps,
    f: { x: r2(f.x), z: r2(f.z), a: r2(f.a), h: f.h.map(r2), ho: f.holders.slice(), sp: r2(Math.hypot(f.vx, f.vz)) },
    g: Math.round(g.gauge * 10) / 10,
    b: g.band,
    e: g.eyes,
    ph: g.phase,
    d: g.doorsOpen,
    vs: g.vases.map((v) => v.broken),
    po: g.pochi ? { x: r2(g.pochi.x), z: r2(g.pochi.z), a: r2(g.pochi.a), st: g.pochi.st } : null,
    ke: g.kenji ? { x: r2(g.kenji.x), z: r2(g.kenji.z), a: r2(g.kenji.a), w: g.kenji.whisper > 0 ? 1 : 0 } : null,
    c: g.collected.length,
    br: g.broken,
    cp: g.cpReached ? 1 : 0,
  });
}

const TICK = 50;
setInterval(() => {
  const dt = TICK / 1000;
  for (const room of rooms.values()) {
    if (room.mode === 'play' && room.game) updateGame(room, dt);
    broadcastState(room);
  }
}, TICK);

// =====================================================================
// 通信
// =====================================================================
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const SHIRT_RE = /^#[0-9a-fA-F]{6}$/;
const HATS = ['none', 'cap', 'straw', 'band', 'crown'];

function sanitizeSkin(s) {
  const shirt = s && SHIRT_RE.test(s.shirt) ? s.shirt : '#e74c3c';
  const hat = s && HATS.includes(s.hat) ? s.hat : 'none';
  return { shirt, hat };
}

io.on('connection', (socket) => {
  let room = null;
  let me = null;

  socket.on('join', (d, ack) => {
    if (room) return;
    const reply = typeof ack === 'function' ? ack : () => {};
    const name = String((d && d.name) || '').trim().slice(0, 10) || '孫';
    let code = String((d && d.code) || '').replace(/\D/g, '').slice(0, 4);
    if (d && d.create) {
      do {
        code = String(Math.floor(1000 + Math.random() * 9000));
      } while (rooms.has(code));
      rooms.set(code, makeRoom(code));
    }
    const r = rooms.get(code);
    if (!r) return reply({ ok: false, error: 'その合言葉の部屋は見つかりません' });
    if (r.players.size >= 4) return reply({ ok: false, error: '満員です（最大4人）' });

    room = r;
    me = {
      id: socket.id, name, skin: sanitizeSkin(d && d.skin),
      x: 0, z: 0, a: 0, frozen: false, pose: 0, sneak: false, humming: false, spd: 0,
      holding: -1, lifting: false, tileKey: '', quietUntil: 0, stats: newStats(),
    };
    r.players.set(socket.id, me);
    socket.join(code);
    reply({
      ok: true,
      id: socket.id,
      code,
      chapters: CHAPTER_ORDER.map((id) => ({ id, name: CHAPTERS[id].name, total: CHAPTERS[id].talks.length })),
    });
    const spawn = r.mode === 'play' && r.game ? spawnAround(r.game, r.players.size - 1) : lobbySpawn(r.players.size - 1);
    me.x = spawn.x;
    me.z = spawn.z;
    me.tileKey = Math.floor(spawn.x) + ',' + Math.floor(spawn.z);
    if (r.game) me.quietUntil = r.game.time + 1.0;
    socket.emit('mode', modePayload(r, spawn));
    emitRoster(r);
  });

  socket.on('pos', (d) => {
    if (!me || !d) return;
    me.x = num(d.x, me.x);
    me.z = num(d.z, me.z);
    me.a = num(d.a, me.a);
    me.frozen = !!d.f;
    me.pose = Math.floor(num(d.ps, 0)) % 4;
    me.sneak = !!d.s;
    me.humming = !!d.h;
    me.spd = clamp(num(d.v, 0), 0, 10);
  });

  socket.on('grab', () => {
    const g = room && room.game;
    if (!g || g.phase !== 'play') return;
    if (me.holding >= 0) {
      releaseHold(room, me);
      return;
    }
    const f = g.futon;
    let best = -1;
    let bd = 1.0;
    for (let i = 0; i < 4; i++) {
      if (f.holders[i]) continue;
      const c = cornerPos(f, i);
      const d = Math.hypot(c.x - me.x, c.z - me.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      f.holders[best] = me.id;
      me.holding = best;
      me.lifting = false;
    }
  });

  socket.on('lift', () => {
    const g = room && room.game;
    if (!g || g.phase !== 'play' || me.holding < 0) return;
    me.lifting = !me.lifting;
    const held = g.futon.holders.filter(Boolean).length;
    if (me.lifting && held < 2) socket.emit('hint', { text: '1人では持ち上がらない…。引きずって運ぼう' });
  });

  socket.on('interact', () => {
    const g = room && room.game;
    if (!g || g.phase !== 'play') return;
    // ポチをなでる
    if (g.pochi && Math.hypot(g.pochi.x - me.x, g.pochi.z - me.z) < 1.4) {
      g.pochi.calm = 12;
      burst(room, 'pet', 0, g.pochi.x, g.pochi.z, 'くぅ〜ん');
      return;
    }
    // ふすまの開け閉め
    let bestDoor = -1;
    let bd = 1.4;
    g.map.doors.forEach((tiles, id) => {
      for (const [tx, tz] of tiles) {
        const d = Math.hypot(tx + 0.5 - me.x, tz + 0.5 - me.z);
        if (d < bd) {
          bd = d;
          bestDoor = id;
        }
      }
    });
    if (bestDoor < 0) return;
    if (g.doorsOpen[bestDoor]) {
      // 布団が挟まっているときは閉めない
      const f = g.futon;
      for (const [tx, tz] of g.map.doors[bestDoor]) {
        for (const off of FUTON_CIRCLES) {
          const cx = f.x + Math.cos(f.a) * off;
          const cz = f.z + Math.sin(f.a) * off;
          const nx = Math.max(tx, Math.min(cx, tx + 1));
          const nz = Math.max(tz, Math.min(cz, tz + 1));
          if (Math.hypot(cx - nx, cz - nz) < FUTON_R) return;
        }
      }
    }
    g.doorsOpen[bestDoor] = !g.doorsOpen[bestDoor];
    const [tx, tz] = g.map.doors[bestDoor][0];
    burst(room, 'door', 0.5, tx + 0.5, tz + 0.5, 'スーッ');
  });

  socket.on('shh', () => {
    if (!room || !me) return;
    io.to(room.code).emit('emote', { id: me.id, text: 'しーっ！' });
    const g = room.game;
    if (g && g.kenji && Math.hypot(g.kenji.x - me.x, g.kenji.z - me.z) < 3.2) {
      g.kenji.whisper = 12;
      burst(room, 'shh', 0, g.kenji.x, g.kenji.z, '（ひそひそ…）');
    }
  });

  socket.on('startChapter', (d) => {
    if (!room || room.mode !== 'lobby') return;
    const id = d && d.id;
    if (!CHAPTERS[id]) return;
    startChapter(room, id);
  });

  socket.on('setCover', (d) => {
    if (!room || !d || !COVERS.includes(d.cover)) return;
    room.cover = d.cover;
    io.to(room.code).emit('cover', { cover: room.cover });
  });

  socket.on('skin', (d) => {
    if (!room || !me) return;
    me.skin = sanitizeSkin(d);
    emitRoster(room);
  });

  socket.on('disconnect', () => {
    if (!room || !me) return;
    if (me.holding >= 0) releaseHold(room, me);
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else emitRoster(room);
  });
});

server.listen(PORT, () => {
  console.log(`おじいちゃん、起こさないで（仮） → http://localhost:${PORT}`);
});
