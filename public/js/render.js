/* Renderer + match director. Owns the canvas, the frame loop and the lobby timer.
   The simulation itself lives in core.js; this module never talks to the network —
   app.js wires the two together. */
import { W, H, CELL, GW, GH, TAU, LAYOUT, FINAL, clamp, Game } from './core.js';
import { makeBots } from './bots.js';

/* ---------- config ---------- */
let LOBBY = 45;        // seconds the lobby stays open
let SIM_COUNT = 300;   // bots used when simulating
let WINNERS = 1;
let cv = null, ctx = null;
const listeners = new Set();
function emit(type, data) { for (const fn of listeners) { try { fn(type, data); } catch (e) { console.error(e); } } }

const C = {
  ink: '#eaf0ff', muted: '#8d97b8', dim: '#4d5778',
  fire: '#ff7a2f', danger: '#ff4b3a', gold: '#ffd36b', sea: '#3fd0ff',
  panel: 'rgba(8,12,26,0.74)', line: 'rgba(160,190,255,0.12)',
};
const ACCENT = { calm: '#7ff0c4', volcano: '#ff8a4a', glacier: '#a9e9ff', final: '#ffd36b' };
const SHORE = { calm: '#6fe3ff', volcano: '#ff7a3a', glacier: '#c8f4ff', final: '#ffd36b' };
const F_DISP = '"Russo One", "Arial Black", sans-serif';
const F_UI = 'Rubik, "Segoe UI", Arial, sans-serif';
const F_MONO = '"JetBrains Mono", Consolas, monospace';

/* ---------- static layers ---------- */
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const bg = mkCanvas(W, H);
(function drawBg() {
  const g = bg.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#060a1a'); grd.addColorStop(0.45, '#081430'); grd.addColorStop(1, '#04101f');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const rg = g.createRadialGradient(W / 2, 600, 100, W / 2, 600, 1000);
  rg.addColorStop(0, 'rgba(40,110,170,0.2)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * W, y = Math.random() * H, s = Math.random();
    g.fillStyle = `rgba(200,220,255,${0.15 + s * 0.5})`;
    g.fillRect(x, y, s > 0.93 ? 2 : 1, s > 0.93 ? 2 : 1);
  }
  g.strokeStyle = 'rgba(90,170,255,0.045)'; g.lineWidth = 1;
  for (const L of LAYOUT) for (let k = 1; k <= 4; k++) { g.beginPath(); g.ellipse(L.cx, L.cy, L.rx + k * 40, L.ry + k * 32, 0, 0, TAU); g.stroke(); }
})();

const ground = mkCanvas(W, H), gctx = ground.getContext('2d');
const shore = mkCanvas(W / 4, H / 4), sctx = shore.getContext('2d');
const sil = mkCanvas(W / 4, H / 4), silctx = sil.getContext('2d');

const glowCache = new Map();
function glowSprite(h) {
  const b = Math.round(h / 10) * 10;
  let s = glowCache.get(b);
  if (!s) {
    s = mkCanvas(56, 56); const g = s.getContext('2d');
    const rg = g.createRadialGradient(28, 28, 0, 28, 28, 28);
    rg.addColorStop(0, `hsla(${b},100%,65%,0.55)`); rg.addColorStop(0.35, `hsla(${b},100%,60%,0.2)`); rg.addColorStop(1, `hsla(${b},100%,60%,0)`);
    g.fillStyle = rg; g.fillRect(0, 0, 56, 56);
    glowCache.set(b, s);
  }
  return s;
}

/* ---------- renderer state ---------- */
let game, R;
function resetRender() {
  R = {
    particles: [], rings: [], craters: [], glows: [], feed: [], banners: [],
    shake: 0, flash: 0, groundDirty: true, groundTimer: 0,
    cam: { x: W / 2, y: H / 2, z: 1 }, winT: -1,
  };
}
function cellColor(key, s, edge) {
  if (key === 'volcano') {
    if (edge === 1) return `hsl(${18 + s * 8} ${22 + s * 8}% ${20 + s * 5}%)`;
    if (edge === 2) return `hsl(${12 + s * 6} ${14 + s * 6}% ${15 + s * 4}%)`;
    return `hsl(${8 + s * 14} ${10 + s * 8}% ${10 + s * 4}%)`;
  }
  if (key === 'glacier') {
    if (edge === 1) return `hsl(${192 + s * 8} ${40 + s * 10}% ${70 + s * 8}%)`;
    if (edge === 2) return `hsl(${198 + s * 8} ${34 + s * 10}% ${58 + s * 6}%)`;
    return `hsl(${204 + s * 10} ${28 + s * 12}% ${44 + s * 9}%)`;
  }
  if (key === 'final') {
    if (edge === 1) return `hsl(${40 + s * 6} ${34 + s * 8}% ${38 + s * 6}%)`;
    if (edge === 2) return `hsl(${36 + s * 8} ${16 + s * 6}% ${25 + s * 4}%)`;
    return `hsl(${228 + s * 10} ${10 + s * 6}% ${18 + s * 5}%)`;
  }
  if (edge === 1) return `hsl(${38 + s * 8} ${18 + s * 8}% ${34 + s * 6}%)`;
  if (edge === 2) return `hsl(${150 + s * 10} ${20 + s * 8}% ${20 + s * 4}%)`;
  if (s > 0.95) return `hsl(222 12% ${22 + s * 6}%)`;
  return `hsl(${158 + s * 14} ${26 + s * 10}% ${14 + s * 5}%)`;
}
function renderGround() {
  const st = game.state, g = gctx;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  silctx.clearRect(0, 0, sil.width, sil.height);
  const land = (gx, gy) => { if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return false; const s = st[gy * GW + gx]; return s === 1 || s === 2; };
  const half = CELL / 2;
  for (const isl of game.islands) {
    const key = isl.prof.key;
    silctx.fillStyle = SHORE[key];
    g.fillStyle = key === 'volcano' ? 'rgba(255,150,90,0.22)' : key === 'final' ? 'rgba(255,220,140,0.25)' : 'rgba(150,230,255,0.22)';
    for (const i of isl.cells) {
      const s = st[i]; if (s !== 1 && s !== 2) continue;
      const gx = i % GW, gy = (i / GW) | 0, x = gx * CELL + half, y = gy * CELL + half;
      silctx.beginPath(); silctx.arc(x / 4, y / 4, 3.6, 0, TAU); silctx.fill();
      if (!land(gx + 1, gy) || !land(gx - 1, gy) || !land(gx, gy + 1) || !land(gx, gy - 1)) { g.beginPath(); g.arc(x, y, CELL * 1.05, 0, TAU); g.fill(); }
    }
  }
  for (const isl of game.islands) {
    const key = isl.prof.key;
    for (const i of isl.cells) {
      const s = st[i]; if (s !== 1 && s !== 2) continue;
      const gx = i % GW, gy = (i / GW) | 0, x = gx * CELL + half, y = gy * CELL + half;
      let edge = 0;
      if (!land(gx + 1, gy) || !land(gx - 1, gy) || !land(gx, gy + 1) || !land(gx, gy - 1)) edge = 1;
      else if (!land(gx + 2, gy) || !land(gx - 2, gy) || !land(gx, gy + 2) || !land(gx, gy - 2)) edge = 2;
      g.fillStyle = cellColor(key, game.shade[i], edge);
      g.beginPath(); g.arc(x, y, CELL * 0.75, 0, TAU); g.fill();
    }
  }
  for (const isl of game.islands) if (isl.prof.key === 'volcano') for (const i of isl.cells) {
    if (game.shade[i] < 0.93 || st[i] !== 1) continue;
    const x = (i % GW) * CELL + half, y = ((i / GW) | 0) * CELL + half;
    g.fillStyle = 'rgba(255,90,30,0.35)'; g.beginPath(); g.arc(x, y, CELL * 0.7, 0, TAU); g.fill();
    g.fillStyle = `hsl(${18 + game.shade[i] * 20} 100% 55%)`; g.beginPath(); g.arc(x, y, CELL * 0.32, 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-atop';
  for (const k of R.craters) drawCrater(g, k);
  g.globalCompositeOperation = 'source-over';
  sctx.clearRect(0, 0, shore.width, shore.height);
  sctx.filter = 'blur(5px)'; sctx.drawImage(sil, 0, 0); sctx.filter = 'none';
}
function drawCrater(g, k) {
  const rr = k.r * 0.8;
  const rg = g.createRadialGradient(k.x, k.y, 0, k.x, k.y, rr);
  rg.addColorStop(0, 'rgba(10,8,12,0.6)'); rg.addColorStop(0.6, 'rgba(22,16,16,0.32)');
  rg.addColorStop(0.9, 'rgba(60,40,30,0.18)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg; g.beginPath(); g.arc(k.x, k.y, rr, 0, TAU); g.fill();
}

/* ---------- particles ---------- */
function P(o) { if (R.particles.length < 3000) R.particles.push(o); }
function burst(x, y, r) {
  const n = Math.min(80, 20 + r * 0.5);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU, sp = 110 + Math.random() * r * 6;
    P({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.4 + Math.random() * 0.6, max: 1, size: 1.5 + Math.random() * 2.5, col: Math.random() < 0.5 ? '#ffd27a' : '#ff6a2a', add: true, drag: 3.5, g: 0 });
  }
  for (let i = 0; i < n * 0.4; i++) {
    const a = Math.random() * TAU, sp = 20 + Math.random() * r * 1.2;
    P({ x: x + Math.cos(a) * r * 0.4, y: y + Math.sin(a) * r * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 15, life: 1.4 + Math.random() * 1.4, max: 2.8, size: 8 + Math.random() * r * 0.25, col: 'rgba(60,62,78,', smoke: true, drag: 1.2, g: -8 });
  }
}
function soul(p) {
  for (let i = 0; i < 8; i++) P({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 70, vy: -40 - Math.random() * 80, life: 0.6 + Math.random() * 0.5, max: 1.1, size: 2 + Math.random() * 2, col: `hsl(${p.hue} 100% 70%)`, add: true, drag: 2, g: -40 });
  P({ x: p.x, y: p.y, vx: 0, vy: -70, life: 1.1, max: 1.1, size: 7, col: `hsl(${p.hue} 100% 72%)`, add: true, drag: 0.5, g: -20, orb: true });
}
function splash(p) {
  R.rings.push({ x: p.x, y: p.y, r0: 4, r1: 34, t: 0, max: 0.7, col: '150,225,255', w: 2 });
  for (let i = 0; i < 12; i++) { const a = Math.random() * TAU; P({ x: p.x, y: p.y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 30, life: 0.5 + Math.random() * 0.4, max: 0.9, size: 2, col: '#bfefff', add: true, drag: 3, g: 60 }); }
}
function confetti() {
  const cols = ['#ffd36b', '#ff7a2f', '#3fd0ff', '#ff5fa2', '#9dff7a', '#ffffff'];
  for (let i = 0; i < 260; i++) P({ x: Math.random() * W, y: -20 - Math.random() * 500, vx: (Math.random() - 0.5) * 80, vy: 120 + Math.random() * 160, life: 5 + Math.random() * 2, max: 7, size: 5 + Math.random() * 5, col: cols[i % cols.length], conf: true, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 10, drag: 0.2, g: 30, screen: true });
}
function ambient() {
  if (game.phase === 'transfer' || game.phase === 'final' || game.phase === 'won') return;
  const v = game.islands[1], gl = game.islands[2];
  if (v && v.cells.length && Math.random() < 0.7) {
    const i = v.cells[Math.floor(Math.random() * v.cells.length)];
    P({ x: (i % GW) * CELL + 7, y: ((i / GW) | 0) * CELL + 7, vx: (Math.random() - 0.5) * 12, vy: -20 - Math.random() * 30, life: 1.5 + Math.random(), max: 2.5, size: 1.2 + Math.random() * 1.6, col: '#ff8a3a', add: true, drag: 0.4, g: -6 });
  }
  if (gl && gl.cells.length && Math.random() < 0.6) {
    P({ x: gl.cx0 + (Math.random() - 0.5) * gl.rx * 2.2, y: gl.cy0 - gl.ry - 60, vx: -10 + Math.random() * 6, vy: 30 + Math.random() * 25, life: 6, max: 6, size: 1.2 + Math.random() * 1.5, col: '#e6f7ff', add: true, drag: 0, g: 0, snow: true });
  }
}

/* ---------- events ---------- */
function islandName(id) { const isl = game.islands[id]; return isl ? isl.prof.name : ''; }
function handleEvents() {
  const groups = new Map();
  for (const e of game.events) {
    if (e.type === 'join') { e.p.dropT = 0.7; R.feed.unshift({ join: true, p: e.p, island: e.p.island, t: 0 }); }
    else if (e.type === 'move') { R.rings.push({ x: e.p.x, y: e.p.y, r0: 4, r1: 26, t: 0, max: 0.5, col: '255,211,107', w: 2 }); R.feed.unshift({ join: true, move: true, p: e.p, island: e.p.island, t: 0 }); }
    else if (e.type === 'impact') {
      R.shake = Math.min(24, R.shake + e.r / 8);
      R.rings.push({ x: e.x, y: e.y, r0: e.r * 0.3, r1: e.r * 2.2, t: 0, max: 0.55, col: '255,190,120', w: 4 });
      burst(e.x, e.y, e.r);
      const k = { x: e.x, y: e.y, r: e.r * 0.9 };
      R.craters.push(k); if (R.craters.length > 90) R.craters.shift();
      gctx.globalCompositeOperation = 'source-atop'; drawCrater(gctx, k); gctx.globalCompositeOperation = 'source-over';
      R.glows.push({ x: e.x, y: e.y, r: e.r, t: 0 });
      if (e.kind === 'giant') R.flash = 0.7;
    } else if (e.type === 'kill') {
      if (e.cause === 'burn') soul(e.p); else splash(e.p);
      if (!e.p.bot) emit('kill', { key: e.p.key, display: e.p.name, platform: e.p.platform, place: e.p.place, cause: e.cause });
      const key = e.cause === 'burn' ? 'm' + e.group : 'd' + Math.random();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    } else if (e.type === 'ground') R.groundDirty = true;
    else if (e.type === 'go') { emit('phase', snapshot()); R.feed.length = 0; R.banners.push({ text: 'ОТБОР', sub: 'чем опаснее остров, тем меньше мест в финале', t: 0 }); }
    else if (e.type === 'wave') R.banners.push({ text: e.label, island: e.island, t: 0, small: true });
    else if (e.type === 'islandDone') R.banners.push({ text: e.count ? 'ОТБОР ПРОЙДЕН' : 'НИКТО НЕ ВЫЖИЛ', island: e.island, t: 0, small: true, gold: !!e.count });
    else if (e.type === 'transfer') { emit('transfer', { count: e.count }); R.craters.length = 0; R.banners.push({ text: 'ФИНАЛИСТЫ', sub: `${e.count} выживших летят на центральный остров`, t: 0 }); }
    else if (e.type === 'land') R.rings.push({ x: e.p.x, y: e.p.y, r0: 4, r1: 40, t: 0, max: 0.6, col: '255,211,107', w: 3 });
    else if (e.type === 'final') R.banners.push({ text: 'ФИНАЛ', sub: game.winnersN === 1 ? 'останется один' : `победят последние ${game.winnersN}`, t: 0 });
    else if (e.type === 'win') {
      R.winT = 0; confetti();
      emit('win', { list: e.list.map((p, i) => ({ key: p.key, display: p.name, platform: p.platform, place: i + 1 })) });
      emit('phase', snapshot());
    }
  }
  game.events.length = 0;
  for (const list of groups.values()) {
    if (list.length >= 3) R.feed.unshift({ multi: list.length, t: 0 });
    else for (const e of list) R.feed.unshift({ p: e.p, cause: e.cause, place: e.p.place, t: 0 });
  }
  if (R.feed.length > 12) R.feed.length = 12;
}

/* ---------- drawing helpers ---------- */
function rrect(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }
function spaced(g, text, x, y, sp, align) {
  const chars = [...text]; let w = 0;
  for (const c of chars) w += g.measureText(c).width + sp; w -= sp;
  let cx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const old = g.textAlign; g.textAlign = 'left';
  for (const c of chars) { g.fillText(c, cx, y); cx += g.measureText(c).width + sp; }
  g.textAlign = old;
}
function fmtTime(s) { s = Math.max(0, Math.floor(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function fitFont(text, size, maxW, family) {
  let fs = size; ctx.font = `${fs}px ${family}`;
  while (ctx.measureText(text).width > maxW && fs > 12) { fs -= 2; ctx.font = `${fs}px ${family}`; }
  return fs;
}

function drawPlayer(p, now, s) {
  const b = 1 + 0.06 * Math.sin(now * 3 + p.phase);
  ctx.drawImage(glowSprite(p.hue), p.x - 28 * s, p.y - 28 * s, 56 * s, 56 * s);
  ctx.fillStyle = p.col || (p.col = `hsl(${p.hue} 92% 62%)`);
  ctx.beginPath(); ctx.arc(p.x, p.y, 8 * b * s, 0, TAU); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath(); ctx.arc(p.x - 2.6 * s, p.y - 3.2 * s, 2.4 * s, 0, TAU); ctx.fill();
  const v = Math.hypot(p.vx, p.vy);
  const ex = v > 5 ? p.vx / v * 2.2 : 0, ey = v > 5 ? p.vy / v * 1.6 : 1;
  ctx.fillStyle = '#0a0f22';
  ctx.beginPath(); ctx.arc(p.x - 3 * s + ex * s, p.y + ey * s, 1.5 * s, 0, TAU); ctx.arc(p.x + 3 * s + ex * s, p.y + ey * s, 1.5 * s, 0, TAU); ctx.fill();
}
function drawName(p, size, col) {
  ctx.font = `600 ${size}px ${F_UI}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.lineWidth = Math.max(2, size * 0.28); ctx.strokeStyle = 'rgba(4,7,16,0.9)'; ctx.lineJoin = 'round';
  const yo = 12 + (p.lift || 0) * 10;
  ctx.strokeText(p.name, p.x, p.y - yo);
  ctx.fillStyle = col || C.ink; ctx.fillText(p.name, p.x, p.y - yo);
}

function drawMeteor(m, now, z) {
  const age = game.gt - m.t0;
  if (age < 0) return;
  const prog = clamp(age / m.warn, 0, 1);
  const pulse = 0.5 + 0.5 * Math.sin(now * (8 + prog * 14));
  const giant = m.kind === 'giant';
  ctx.fillStyle = `rgba(255,70,50,${0.08 + prog * 0.08})`;
  ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.fill();
  ctx.fillStyle = `rgba(255,90,55,${0.18 + prog * 0.2})`;
  ctx.beginPath(); ctx.arc(m.x, m.y, m.r * prog, 0, TAU); ctx.fill();
  ctx.strokeStyle = `rgba(255,80,60,${0.55 + 0.4 * pulse})`;
  ctx.lineWidth = (giant ? 4 : 2.4) / Math.sqrt(z);
  ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, TAU); ctx.stroke();
  ctx.setLineDash([10, 9]); ctx.lineDashOffset = -now * 40;
  ctx.strokeStyle = `rgba(255,120,80,${0.35 + 0.3 * pulse})`; ctx.lineWidth = 1.5 / Math.sqrt(z);
  ctx.beginPath(); ctx.arc(m.x, m.y, m.r + 7, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  const c = Math.min(10, m.r * 0.2);
  ctx.strokeStyle = 'rgba(255,200,170,0.75)'; ctx.lineWidth = 2 / Math.sqrt(z);
  ctx.beginPath(); ctx.moveTo(m.x - c, m.y - c); ctx.lineTo(m.x + c, m.y + c); ctx.moveTo(m.x + c, m.y - c); ctx.lineTo(m.x - c, m.y + c); ctx.stroke();
  const fall = Math.min(0.55, m.warn * 0.45), fs = age - (m.warn - fall);
  if (fs > 0) {
    const f = Math.pow(clamp(fs / fall, 0, 1), 1.5);
    const dx = 0.52, dy = -0.854, dist = 950 * (1 - f);
    const hx = m.x + dx * dist, hy = m.y + dy * dist;
    const hs = clamp(m.r * 0.26, 7, 34);
    ctx.fillStyle = `rgba(0,0,0,${0.35 * f})`;
    ctx.beginPath(); ctx.ellipse(m.x, m.y, m.r * 0.45 * f, m.r * 0.3 * f, 0, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const tl = hs * 9;
    const tg = ctx.createLinearGradient(hx, hy, hx + dx * tl, hy + dy * tl);
    tg.addColorStop(0, 'rgba(255,170,80,0.9)'); tg.addColorStop(0.4, 'rgba(255,90,40,0.35)'); tg.addColorStop(1, 'rgba(255,60,30,0)');
    ctx.strokeStyle = tg; ctx.lineCap = 'round'; ctx.lineWidth = hs * 1.5;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + dx * tl, hy + dy * tl); ctx.stroke(); ctx.lineCap = 'butt';
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hs * 2.2);
    hg.addColorStop(0, 'rgba(255,255,240,1)'); hg.addColorStop(0.25, 'rgba(255,210,120,0.95)'); hg.addColorStop(0.6, 'rgba(255,110,40,0.45)'); hg.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(hx, hy, hs * 2.2, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 2; i++) P({ x: hx + (Math.random() - 0.5) * hs, y: hy + (Math.random() - 0.5) * hs, vx: dx * 120 + (Math.random() - 0.5) * 60, vy: dy * 120 + (Math.random() - 0.5) * 60, life: 0.35 + Math.random() * 0.3, max: 0.65, size: 1.5 + Math.random() * 2, col: '#ffb45a', add: true, drag: 2, g: 0 });
  }
}

/* island labels in world space */
const DCOL = { 1: '#7fe08a', 2: '#ffc14d', 3: '#ff5a45' };
const DWORD = { 1: 'НИЗКАЯ', 2: 'СРЕДНЯЯ', 3: 'ВЫСОКАЯ' };
function meteorIcon(x, y, on, col) {
  ctx.strokeStyle = on ? col : 'rgba(140,150,180,0.25)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x + 11, y - 11); ctx.stroke(); ctx.lineCap = 'butt';
  ctx.fillStyle = on ? col : 'rgba(140,150,180,0.25)';
  ctx.beginPath(); ctx.arc(x, y, 5, 0, TAU); ctx.fill();
}
function drawIslandLabels() {
  const ph = game.phase;
  if (!(ph === 'idle' || ph === 'lobby' || ph === 'countdown' || ph === 'qual')) return;
  game.islands.forEach((isl, idx) => {
    if (idx > 2) return;
    const key = isl.prof.key, x = isl.cx0, y = isl.cy0 - isl.ry - 78;
    const rt = ph === 'qual' ? 99 : ph === 'countdown' ? (3 - game.cd) - (0.3 + idx * 0.8) : -1;
    const shown = rt >= 0;
    const dc = shown ? DCOL[isl.danger] : '#8d97b8';
    let line3, col3 = C.muted;
    if (!shown) line3 = `${isl.n} ${plural(isl.n, 'игрок', 'игрока', 'игроков')}`;
    else if (ph === 'qual' || ph === 'countdown') {
      if (isl.done) { line3 = isl.alive ? `отбор пройден · в финале ${isl.alive}` : 'никто не выжил'; col3 = isl.alive ? C.gold : C.dim; }
      else line3 = `в игре ${isl.alive}  ·  пройдут ${isl.quota}`;
    } else {
      const n = isl.n, ch = n ? Math.min(100, Math.round(isl.quota / n * 100)) : 100;
      line3 = `${n} ${plural(n, 'игрок', 'игрока', 'игроков')}  ·  пройдут ${isl.quota}  ·  шанс ~${ch}%`;
    }
    const name = isl.prof.name.toUpperCase();
    ctx.font = `24px ${F_DISP}`; const w1 = ctx.measureText(name).width + 24;
    ctx.font = `500 17px ${F_UI}`; const w3 = ctx.measureText(line3).width;
    const tag = ph === 'lobby' || ph === 'idle' ? `!join ${idx + 1}` : '';
    ctx.font = `600 15px ${F_MONO}`; const wt = tag ? ctx.measureText(tag).width + 22 : 0;
    const word = shown ? DWORD[isl.danger] : 'СКРЫТА';
    ctx.font = `600 13px ${F_UI}`; const wd = ctx.measureText('ОПАСНОСТЬ  ' + word).width + 3 * 22 + 30;
    const w = Math.max(w1 + wt, w3, wd, 300) + 40, h = 104;
    const pop = shown && rt < 0.5 ? 1 + 0.12 * Math.sin(rt / 0.5 * Math.PI) : 1;
    ctx.save(); ctx.translate(x, y + 22); ctx.scale(pop, pop); ctx.translate(-x, -(y + 22));
    ctx.fillStyle = C.panel; rrect(ctx, x - w / 2, y - 30, w, h, 16); ctx.fill();
    if (shown && rt < 0.8) { ctx.fillStyle = dc; ctx.globalAlpha = 0.25 * (1 - rt / 0.8); rrect(ctx, x - w / 2, y - 30, w, h, 16); ctx.fill(); ctx.globalAlpha = 1; }
    ctx.strokeStyle = shown ? dc + '66' : C.line; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    const startX = x - (w1 + wt) / 2;
    ctx.fillStyle = ACCENT[key]; ctx.font = `24px ${F_DISP}`; spaced(ctx, name, startX, y + 4, 1.5, 'left');
    if (tag) {
      const tx = startX + w1;
      ctx.fillStyle = 'rgba(255,122,47,0.16)'; rrect(ctx, tx, y - 17, wt - 6, 26, 7); ctx.fill();
      ctx.fillStyle = C.fire; ctx.font = `600 15px ${F_MONO}`; ctx.fillText(tag, tx + 8, y + 1);
    }
    // danger row
    ctx.font = `600 13px ${F_UI}`;
    const lw = ctx.measureText('ОПАСНОСТЬ').width, ww = ctx.measureText(word).width;
    const rowW = lw + 14 + 3 * 22 + 8 + ww, rx = x - rowW / 2, ry = y + 34;
    ctx.fillStyle = C.muted; spaced(ctx, 'ОПАСНОСТЬ', rx, ry, 1, 'left');
    if (shown) for (let k = 0; k < 3; k++) meteorIcon(rx + lw + 22 + k * 22, ry - 4, k < isl.danger, dc);
    else { ctx.font = `20px ${F_DISP}`; ctx.textAlign = 'center'; for (let k = 0; k < 3; k++) { ctx.fillStyle = `rgba(141,151,184,${0.45 + 0.35 * Math.sin(performance.now() / 300 + k + idx)})`; ctx.fillText('?', rx + lw + 22 + k * 22, ry + 1); } ctx.textAlign = 'left'; ctx.font = `600 13px ${F_UI}`; }
    ctx.fillStyle = dc; spaced(ctx, word, rx + lw + 14 + 3 * 22 + 8, ry, 1, 'left');
    ctx.textAlign = 'center'; ctx.fillStyle = col3; ctx.font = `500 17px ${F_UI}`; ctx.fillText(line3, x, y + 62);
    ctx.restore();
  });
}
function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return a; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return b; return c; }

/* ---------- HUD ---------- */
function drawHUD(now, dt) {
  const ph = game.phase;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.font = `26px ${F_DISP}`;
  spaced(ctx, 'МЕТЕОРИТНЫЙ ДОЖДЬ', 48, 66, 2, 'left');
  ctx.fillStyle = C.muted; ctx.font = `500 15px ${F_MONO}`;
  ctx.fillText(`сид ${game.seed.toString(16).toUpperCase().padStart(8, '0')}  ·  победителей: ${game.winnersN}`, 48, 92);
  if (ph !== 'idle' && ph !== 'lobby') {
    const N = game.startCount, a = game.alive;
    const label = ph === 'final' || ph === 'won' ? 'ФИНАЛ · В ИГРЕ' : ph === 'transfer' ? 'ФИНАЛИСТОВ' : 'ОТБОР · В ИГРЕ';
    ctx.font = `58px ${F_DISP}`; const aw = ctx.measureText(String(a)).width;
    ctx.font = `28px ${F_DISP}`; const nw = ctx.measureText('/ ' + N).width;
    const w = Math.max(aw + nw + 70, 220), x = W / 2 - w / 2;
    ctx.fillStyle = C.panel; rrect(ctx, x, 26, w, 92, 18); ctx.fill();
    ctx.strokeStyle = ph === 'final' ? 'rgba(255,211,107,0.3)' : C.line; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = ph === 'final' ? C.gold : C.muted; ctx.font = `600 13px ${F_UI}`; spaced(ctx, label, W / 2, 50, 3, 'center');
    const sx = W / 2 - (aw + nw + 10) / 2;
    ctx.textAlign = 'left'; ctx.fillStyle = C.ink; ctx.font = `58px ${F_DISP}`; ctx.fillText(String(a), sx, 106);
    ctx.fillStyle = C.dim; ctx.font = `28px ${F_DISP}`; ctx.fillText('/ ' + N, sx + aw + 10, 104);
    ctx.textAlign = 'right'; ctx.fillStyle = C.muted; ctx.font = `600 13px ${F_UI}`; spaced(ctx, 'ВРЕМЯ', W - 48, 50, 3, 'right');
    ctx.fillStyle = C.ink; ctx.font = `34px ${F_DISP}`; ctx.textAlign = 'right'; ctx.fillText(fmtTime(game.playT), W - 48, 88);
  }
  // feed (right side)
  if (ph === 'qual' || ph === 'final' || ph === 'lobby') {
    let y = 160, rowsLeft = ph === 'final' ? 12 : ph === 'lobby' ? 4 : 4;
    for (const f of R.feed) {
      if (rowsLeft <= 0) break;
      f.t += dt;
      const life = f.join ? 3.5 : 5;
      const a = clamp(1 - (f.t - life) / 1.5, 0, 1); if (a <= 0) continue;
      ctx.globalAlpha = a; ctx.textAlign = 'right';
      if (f.join) {
        if (ph !== 'lobby') continue;
        const isl = game.islands[f.island];
        ctx.font = `500 16px ${F_UI}`; ctx.fillStyle = ACCENT[isl.prof.key]; const t2 = isl.prof.name;
        ctx.fillText(t2, W - 48, y); let off = ctx.measureText(t2).width;
        ctx.fillStyle = C.dim; const t1 = f.move ? '  ⇄  ' : '  →  '; ctx.fillText(t1, W - 48 - off, y); off += ctx.measureText(t1).width;
        ctx.font = `600 17px ${F_UI}`; ctx.fillStyle = f.p.col || C.ink; ctx.fillText(f.p.name, W - 48 - off, y);
      } else if (f.multi) {
        ctx.font = `600 18px ${F_UI}`; ctx.fillStyle = C.muted; const t2 = ' сгорели разом';
        ctx.fillText(t2, W - 48, y); const w2 = ctx.measureText(t2).width;
        ctx.font = `22px ${F_DISP}`; ctx.fillStyle = C.fire; ctx.fillText('×' + f.multi, W - 48 - w2, y);
      } else {
        ctx.font = `500 15px ${F_MONO}`; ctx.fillStyle = C.dim; const t3 = '  #' + f.place;
        ctx.fillText(t3, W - 48, y); let off = ctx.measureText(t3).width;
        ctx.font = `500 17px ${F_UI}`; ctx.fillStyle = C.muted; const t2 = f.cause === 'burn' ? ' сгорел' : ' утонул';
        ctx.fillText(t2, W - 48 - off, y); off += ctx.measureText(t2).width;
        ctx.font = `600 18px ${F_UI}`; ctx.fillStyle = f.p.col || C.ink; ctx.fillText(f.p.name, W - 48 - off, y);
      }
      y += 30; rowsLeft--;
    }
    ctx.globalAlpha = 1;
  }
  // finalists list
  if (ph === 'final' || ph === 'transfer') {
    const alive = game.players.filter(p => p.alive);
    const rows = Math.min(alive.length, 16), h = 70 + rows * 32;
    ctx.fillStyle = C.panel; rrect(ctx, 40, 140, 300, h, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(255,211,107,0.25)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = C.gold; ctx.font = `600 13px ${F_UI}`; spaced(ctx, 'ФИНАЛИСТЫ', 64, 172, 3, 'left');
    ctx.fillStyle = C.muted; ctx.font = `500 14px ${F_UI}`;
    ctx.fillText(game.winnersN === 1 ? 'победит последний' : `победят ${game.winnersN}`, 64, 194);
    alive.slice(0, rows).forEach((p, i) => {
      const y = 228 + i * 32;
      ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(72, y - 6, 7, 0, TAU); ctx.fill();
      ctx.fillStyle = C.ink; fitFont(p.name, 19, 230, F_UI);
      ctx.fillText(p.name, 90, y);
    });
  }
  // banners
  for (const b of R.banners) {
    b.t += dt;
    const a = b.t < 0.25 ? b.t / 0.25 : clamp(1 - (b.t - 1.8) / 0.5, 0, 1);
    const sc = 1 + 0.15 * Math.max(0, 1 - b.t * 4);
    let bx = W / 2, by = 220;
    if (b.island !== undefined) { const isl = game.islands[b.island]; if (isl) { bx = isl.cx0; by = isl.cy0 - 10; } }
    ctx.save(); ctx.globalAlpha = a; ctx.translate(bx, by); ctx.scale(sc, sc);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    if (b.small) {
      ctx.font = `30px ${F_DISP}`;
      ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(4,7,16,0.8)'; ctx.lineJoin = 'round'; ctx.strokeText(b.text, 0, 0);
      ctx.fillStyle = b.gold ? C.gold : C.fire; ctx.fillText(b.text, 0, 0);
    } else {
      ctx.fillStyle = C.gold; ctx.font = `60px ${F_DISP}`; spaced(ctx, b.text, 0, 0, 8, 'center');
      if (b.sub) { ctx.fillStyle = C.ink; ctx.font = `500 21px ${F_UI}`; ctx.fillText(b.sub, 0, 38); }
    }
    ctx.restore();
  }
  R.banners = R.banners.filter(b => b.t < 2.4);
  // lobby
  if (ph === 'lobby' || ph === 'idle') {
    const w = 860, h = 178, x = W / 2 - w / 2, y = H - h - 36;
    ctx.fillStyle = C.panel; rrect(ctx, x, y, w, h, 24); ctx.fill(); ctx.strokeStyle = C.line; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = `44px ${F_DISP}`;
    const parts = [['ПИШИ ', C.ink], ['!join 1', C.fire], [', ', C.ink], ['2', C.fire], [' ИЛИ ', C.ink], ['3', C.fire]];
    let tw = 0; for (const [t] of parts) tw += ctx.measureText(t).width;
    let sx = W / 2 - tw / 2; ctx.textAlign = 'left';
    for (const [t, c] of parts) { ctx.fillStyle = c; ctx.fillText(t, sx, y + 64); sx += ctx.measureText(t).width; }
    ctx.textAlign = 'center'; ctx.font = `500 19px ${F_UI}`; ctx.fillStyle = C.muted;
    ctx.fillText('опасность островов откроется после старта · просто !join — на свободный остров', W / 2, y + 98);
    ctx.fillStyle = C.ink; ctx.font = `500 21px ${F_UI}`;
    const left = ph === 'lobby' ? `  ·  старт через ${fmtTime(lobbyLeft)}` : '  ·  ждём открытия набора';
    ctx.fillText(`Участников: ${game.alive}  ·  победителей: ${game.winnersN}${left}`, W / 2, y + 134);
    if (ph === 'lobby') {
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; rrect(ctx, x + 60, y + 154, w - 120, 6, 3); ctx.fill();
      ctx.fillStyle = C.fire; rrect(ctx, x + 60, y + 154, (w - 120) * clamp(1 - lobbyLeft / lobbyDur, 0, 1), 6, 3); ctx.fill();
    }
  }
  if (ph === 'countdown') {
    const n = Math.ceil(game.cd), fr = game.cd - Math.floor(game.cd);
    ctx.save(); ctx.translate(W / 2, H / 2 + 40); const sc = 1 + fr * 0.5; ctx.scale(sc, sc);
    ctx.globalAlpha = clamp(fr * 1.6, 0, 1); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 10; ctx.strokeStyle = 'rgba(4,7,16,0.7)'; ctx.font = `180px ${F_DISP}`; ctx.strokeText(String(n), 0, 0);
    ctx.fillStyle = C.gold; ctx.fillText(String(n), 0, 0); ctx.restore();
  }
  if (ph === 'won' && game.winners.length) drawWinners(now, dt);
}

function drawWinners(now, dt) {
  R.winT += dt;
  const list = game.winners, a = clamp(R.winT / 0.8, 0, 1);
  ctx.fillStyle = `rgba(3,5,12,${0.66 * a})`; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = a;
  const cx = W / 2;
  ctx.globalCompositeOperation = 'lighter';
  const hue = list[0].hue, cy0 = list.length === 1 ? 410 : 300;
  for (let i = 0; i < 18; i++) {
    const ang = now * 0.25 + i * TAU / 18;
    ctx.fillStyle = `hsla(${list.length === 1 ? hue : 45},100%,65%,0.045)`;
    ctx.beginPath(); ctx.moveTo(cx, cy0); ctx.arc(cx, cy0, 560, ang, ang + 0.12); ctx.closePath(); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const grow = 0.6 + 0.4 * clamp(R.winT / 0.6, 0, 1);
  if (list.length === 1) {
    const p = list[0];
    drawPlayer({ ...p, x: cx, y: 410, vx: 0, vy: 1, lift: 0 }, now, 7 * grow);
    ctx.fillStyle = C.gold; ctx.font = `600 22px ${F_UI}`; spaced(ctx, 'ПОБЕДИТЕЛЬ', cx, 560, 8, 'center');
    fitFont(p.name, 84, 1100, F_DISP);
    ctx.fillStyle = C.ink; ctx.fillText(p.name, cx, 650);
    ctx.fillStyle = C.muted; ctx.font = `500 26px ${F_UI}`;
    ctx.fillText(`выжил среди ${game.startCount} участников`, cx, 700);
  } else {
    ctx.fillStyle = C.gold; ctx.font = `600 22px ${F_UI}`; spaced(ctx, 'ПОБЕДИТЕЛИ', cx, 170, 8, 'center');
    ctx.fillStyle = C.muted; ctx.font = `500 22px ${F_UI}`;
    ctx.fillText(`${list.length} выживших из ${game.startCount}`, cx, 205);
    const perRow = list.length <= 5 ? list.length : Math.ceil(list.length / 2);
    const rows = Math.ceil(list.length / perRow), cw = 300, chh = 250, gap = 22;
    const top = rows === 1 ? 330 : 260;
    list.forEach((p, i) => {
      const r = Math.floor(i / perRow), inRow = Math.min(perRow, list.length - r * perRow), c = i % perRow;
      const rowW = inRow * cw + (inRow - 1) * gap;
      const x = cx - rowW / 2 + c * (cw + gap), y = top + r * (chh + gap);
      const d = clamp((R.winT - i * 0.08) / 0.4, 0, 1);
      ctx.save(); ctx.globalAlpha = a * d; ctx.translate(0, (1 - d) * 30);
      ctx.fillStyle = 'rgba(12,18,36,0.85)'; rrect(ctx, x, y, cw, chh, 18); ctx.fill();
      ctx.strokeStyle = 'rgba(255,211,107,0.35)'; ctx.lineWidth = 1.5; ctx.stroke();
      drawPlayer({ ...p, x: x + cw / 2, y: y + 95, vx: 0, vy: 1, lift: 0 }, now, 3.6);
      ctx.textAlign = 'center';
      fitFont(p.name, 30, cw - 30, F_DISP); ctx.fillStyle = C.ink; ctx.fillText(p.name, x + cw / 2, y + 190);
      ctx.fillStyle = C.gold; ctx.font = `600 14px ${F_UI}`; spaced(ctx, 'ПОБЕДИТЕЛЬ', x + cw / 2, y + 222, 3, 'center');
      ctx.restore();
    });
  }
  ctx.textAlign = 'center'; ctx.fillStyle = C.dim; ctx.font = `500 16px ${F_MONO}`;
  ctx.fillText(`сид ${game.seed.toString(16).toUpperCase().padStart(8, '0')}  ·  ${fmtTime(game.playT)}`, cx, list.length === 1 ? 740 : H - 70);
  ctx.restore();
}

/* ---------- frame ---------- */
let last = performance.now(), beatAcc = 0, lobbyLeft = 0, lobbyDur = LOBBY, fakeQueue = [], fakeAcc = 0, fakeRate = 0, swapAcc = 0;
function frame(nowMs) {
  const dt = Math.min(0.05, (nowMs - last) / 1000); last = nowMs;
  const now = nowMs / 1000;
  if (game.phase === 'lobby') {
    lobbyLeft -= dt;
    if (fakeQueue.length) {
      fakeAcc += fakeRate * dt;
      while (fakeAcc >= 1 && fakeQueue.length) { fakeAcc--; addBot(fakeQueue.shift()); }
    }
    if (botsActive && game.alive > 30) {
      swapAcc += dt * 1.6;
      while (swapAcc >= 1) { swapAcc--; const bots = game.players; const p = bots[Math.floor(Math.random() * bots.length)]; if (p && p.bot) game.addPlayer({ key: p.key, display: p.name, platform: p.platform }, game.leastIsland() + 1); }
    }
    if (lobbyLeft <= 0) { if (game.start()) emit('phase', snapshot()); else { lobbyLeft = 10; lobbyDur = 10; } }
  }
  game.update(dt);
  handleEvents();

  // Heartbeat: the host mirrors phase/alive/island counts, and those move
  // continuously (joins during the lobby, deaths during a match), so transition
  // events alone would leave the control panel stale.
  beatAcc += dt;
  if (beatAcc >= 1) { beatAcc = 0; emit('phase', snapshot()); }
  ambient();
  R.groundTimer -= dt;
  if (R.groundDirty && R.groundTimer <= 0) { renderGround(); R.groundDirty = false; R.groundTimer = game.phase === 'transfer' ? 0.08 : 0.2; }

  // camera
  const cam = R.cam; let tx = W / 2, ty = H / 2, tz = 1;
  if (game.phase === 'final') {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of game.players) if (p.alive) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    tx = (x0 + x1) / 2 - 60; ty = (y0 + y1) / 2 - 30;
    tz = clamp(Math.min(W / (x1 - x0 + 800), H / (y1 - y0 + 560)), 1, 1.9);
  } else if (game.phase === 'transfer') { tx = FINAL.cx - 40; ty = FINAL.cy - 40; tz = 1.08; }
  else if (game.phase === 'won' && game.winners.length === 1) { tx = game.winners[0].x; ty = game.winners[0].y; tz = 1.5; }
  const k = Math.min(1, dt * 2.2);
  cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; cam.z += (tz - cam.z) * k;
  const hw = W / 2 / cam.z, hh = H / 2 / cam.z;
  cam.x = clamp(cam.x, hw, W - hw); cam.y = clamp(cam.y, hh, H - hh);
  R.shake *= Math.pow(0.02, dt);
  const sx = (Math.random() - 0.5) * R.shake, sy = (Math.random() - 0.5) * R.shake;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg, 0, 0);
  ctx.setTransform(cam.z, 0, 0, cam.z, W / 2 - cam.x * cam.z + sx, H / 2 - cam.y * cam.z + sy);
  ctx.globalAlpha = 0.45 + 0.15 * Math.sin(now * 1.4);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(shore, -12, -12, W + 24, H + 24);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.drawImage(ground, 0, 0);
  // sinking / rising cells
  for (const isl of game.islands) for (const i of isl.cells) {
    const s = game.state[i]; if (s !== 2 && s !== 3) continue;
    const x = (i % GW) * CELL + 7, y = ((i / GW) | 0) * CELL + 7;
    if (s === 2) {
      const t = clamp(game.sinkT[i] / 0.9, 0, 1);
      if (t <= 0) continue;
      ctx.fillStyle = `rgba(6,18,40,${t})`; ctx.beginPath(); ctx.arc(x, y, CELL * 0.8, 0, TAU); ctx.fill();
      if (Math.sin(now * 30 + i) > 0.3) { ctx.fillStyle = `rgba(120,220,255,${0.35 * (1 - t)})`; ctx.fillRect(x - 5, y - 1, 10, 2); }
    } else {
      const t = clamp(1 + game.sinkT[i] / 0.4, 0, 1);
      if (t <= 0) continue;
      ctx.fillStyle = `rgba(255,211,107,${0.35 * t})`; ctx.beginPath(); ctx.arc(x, y, CELL * 0.75 * t, 0, TAU); ctx.fill();
    }
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const gl of R.glows) {
    gl.t += dt; const a = clamp(1 - gl.t / 3.5, 0, 1); if (a <= 0) continue;
    const rg = ctx.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.r * 0.9);
    rg.addColorStop(0, `rgba(255,120,40,${0.45 * a})`); rg.addColorStop(0.6, `rgba(255,70,20,${0.18 * a})`); rg.addColorStop(1, 'rgba(255,40,10,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(gl.x, gl.y, gl.r * 0.9, 0, TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  R.glows = R.glows.filter(g => g.t < 3.5);
  for (const m of game.meteors) if (game.gt - m.t0 < m.warn - 0.55) drawMeteor(m, now, cam.z);
  // players
  const alive = game.players.filter(p => p.alive);
  const showAll = game.phase === 'final' || game.phase === 'transfer';
  const named = [];
  const fewOn = new Set(game.islands.filter(i => i.alive <= 12).map(i => i.id));
  for (const p of alive) {
    if (p.dropT > 0) {
      p.dropT -= dt;
      const f = clamp(p.dropT / 0.7, 0, 1);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `hsla(${p.hue},100%,70%,${0.7 * f})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(p.x, p.y - f * 420); ctx.lineTo(p.x, p.y - f * 420 - 60); ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      if (p.dropT <= 0) R.rings.push({ x: p.x, y: p.y, r0: 4, r1: 26, t: 0, max: 0.5, col: '200,230,255', w: 2 });
      if (f > 0.02) continue;
    }
    if (game.phase === 'won' && R.winT > 0.3) continue;
    if (p.lift > 0.05) {
      P({ x: p.x, y: p.y, vx: (Math.random() - 0.5) * 20, vy: 10, life: 0.5, max: 0.5, size: 3, col: `hsl(${p.hue} 100% 70%)`, add: true, drag: 1, g: 0 });
      drawPlayer(p, now, 1 + p.lift * 0.5);
    } else drawPlayer(p, now, 1);
    let inDanger = false;
    if (game.phase === 'qual' && !fewOn.has(p.island)) for (const m of game.meteors) { if (game.gt >= m.t0 && Math.hypot(p.x - m.x, p.y - m.y) < m.r) { inDanger = true; break; } }
    const recent = game.phase === 'lobby' && game.t - p.joinT < 2.5;
    if (p.hl > 0) p.hl -= dt;
    if (showAll || (game.phase === 'qual' && fewOn.has(p.island)) || inDanger || recent || p.hl > 0) named.push(p);
  }
  for (const m of game.meteors) if (game.gt - m.t0 >= m.warn - 0.55) drawMeteor(m, now, cam.z);
  for (const r of R.rings) {
    r.t += dt; const f = clamp(r.t / r.max, 0, 1);
    ctx.strokeStyle = `rgba(${r.col},${0.8 * (1 - f)})`; ctx.lineWidth = r.w * (1 - f) + 0.5;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * (1 - Math.pow(1 - f, 3)), 0, TAU); ctx.stroke();
  }
  R.rings = R.rings.filter(r => r.t < r.max);
  drawParticles(dt, false);
  const ns = clamp(13 / Math.sqrt(cam.z) * 1.15, 12, 16);
  for (const p of named) {
    drawName(p, p.hl > 0 ? 20 : ns, p.hl > 0 ? C.gold : undefined);
    if (p.hl > 0) { ctx.strokeStyle = C.gold; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, 16 + 4 * Math.sin(now * 8), 0, TAU); ctx.stroke(); }
  }
  drawIslandLabels();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (R.flash > 0) { ctx.fillStyle = `rgba(255,220,180,${R.flash * 0.5})`; ctx.fillRect(0, 0, W, H); R.flash = Math.max(0, R.flash - dt * 2); }
  if (game.phase === 'final') {
    const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(40,0,0,0.45)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
  }
  drawHUD(now, dt);
  drawParticles(dt, true);
  requestAnimationFrame(frame);
}
function drawParticles(dt, screen) {
  const arr = R.particles;
  for (const p of arr) {
    if (!!p.screen !== screen) continue;
    p.life -= dt;
    const dr = Math.exp(-p.drag * dt);
    p.vx *= dr; p.vy = p.vy * dr + p.g * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    if (p.life <= 0) continue;
    const a = p.snow ? Math.min(1, p.life / 2) * 0.7 : clamp(p.life / p.max, 0, 1);
    if (p.smoke) {
      ctx.fillStyle = p.col + (0.32 * a) + ')';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, TAU); ctx.fill();
    } else if (p.conf) {
      p.rot += p.vr * dt; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, p.life); ctx.fillStyle = p.col; ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore(); ctx.globalAlpha = 1;
    } else {
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a; ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (p.orb || p.snow ? 1 : a + 0.3), 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
  }
  if (screen) R.particles = arr.filter(p => p.life > 0);
}

/* ---------- match director ---------- */
let botsActive = false;

function newGame(openLobby) {
  game = new Game((Math.random() * 4294967296) >>> 0, WINNERS);
  resetRender();
  renderGround();
  fakeQueue = []; botsActive = false;
  emit('newgame', { seed: game.seed, winners: game.winnersN });
  if (openLobby) startLobby();
  else emit('phase', snapshot());
}

/* seed/winners/simulate may be forced by the host so a reloaded overlay lands on the same match */
function startLobby(opts) {
  const o = opts || {};
  if (o.seed !== undefined) { game = new Game(o.seed >>> 0, o.winners || WINNERS); resetRender(); renderGround(); }
  else if (game.phase !== 'idle') newGame(false);
  if (o.winners) { WINNERS = clamp(o.winners | 0, 1, 20); game.setWinners(WINNERS); }
  game.openLobby();
  lobbyDur = lobbyLeft = (o.lobby !== undefined ? clamp(+o.lobby, 5, 600) : LOBBY);
  if (o.left !== undefined) lobbyLeft = clamp(+o.left, 0, lobbyDur);
  fakeQueue = []; botsActive = false;
  if (o.simulate) {
    fakeQueue = makeBots(o.bots || SIM_COUNT);
    fakeRate = fakeQueue.length / Math.max(1, lobbyDur * 0.7);
    fakeAcc = 0; botsActive = true;
  }
  emit('phase', snapshot());
}

function addBot(b) { const p = game.addPlayer(b, b.choice); if (p) p.bot = true; return p; }

function forceStart() {
  if (game.phase !== 'lobby') return false;
  fakeQueue.forEach(addBot); fakeQueue = [];
  const ok = game.start();
  if (ok) emit('phase', snapshot());
  return ok;
}

function setWinners(n) {
  WINNERS = clamp(n | 0, 1, 20);
  game.setWinners(WINNERS);
  return game.winnersN;
}

/* who: { key, display, platform }, choice: 0..3 */
function addPlayer(who, choice) {
  const p = game.addPlayer(who, choice);
  if (p) p.hl = Math.max(p.hl, 1.2);
  return p ? { key: p.key, display: p.name, island: p.island + 1 } : null;
}

function snapshot() {
  return {
    phase: game.phase, alive: game.alive, winners: game.winnersN, seed: game.seed,
    lobbyLeft: game.phase === 'lobby' ? Math.max(0, lobbyLeft) : 0,
    lobbyDur, simulated: botsActive,
    islands: game.islands.filter(i => i.id < 3).map(i => ({ id: i.id + 1, name: i.prof.name, danger: i.danger, quota: i.quota, players: i.n })),
  };
}

function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* Attach to a canvas and start the frame loop. */
function mount(canvas, cfg) {
  const o = cfg || {};
  cv = canvas; ctx = cv.getContext('2d');
  cv.width = W; cv.height = H;
  if (o.lobby !== undefined) LOBBY = clamp(+o.lobby, 5, 600);
  if (o.bots !== undefined) SIM_COUNT = clamp(o.bots | 0, 2, 1000);
  if (o.winners !== undefined) WINNERS = clamp(o.winners | 0, 1, 20);
  newGame(false);
  if (o.simulate) startLobby({ simulate: true });
  requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });
}

export { mount, newGame, startLobby, forceStart, setWinners, addPlayer, snapshot, onEvent };
