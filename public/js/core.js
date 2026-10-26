const W = 1920, H = 1080, CELL = 14, GW = Math.ceil(W / CELL), GH = Math.ceil(H / CELL);
const TAU = Math.PI * 2;
const QT = 44, QMIN = 32, QMAX = 60;
const DANGER = { 1: { r: 0.82, warn: 1.2, hails: [] }, 2: { r: 1, warn: 1, hails: [] }, 3: { r: 1.22, warn: 0.82, hails: [9, 21] } };   // qualifier pacing (game seconds)

const PROFILES = {
  calm:    { key: 'calm',    name: 'Тихая гавань', shape: u => u * u,                    base: 2.4, r: [34, 46], warn: [1.8, 1.05], hail: [],      giant: [34], slip: 7,   glacier: false, shard: false },
  volcano: { key: 'volcano', name: 'Вулкан',       shape: u => 1 - Math.pow(1 - u, 2.6), base: 2.6, r: [50, 72], warn: [1.35, 1.0], hail: [5, 15], giant: [],   slip: 7,   glacier: false, shard: true },
  glacier: { key: 'glacier', name: 'Ледник',       shape: u => u,                        base: 1.4, r: [40, 54], warn: [1.6, 1.2],  hail: [],      giant: [],   slip: 1.6, glacier: true,  shard: false },
  final:   { key: 'final',   name: 'Финал',        shape: u => u,                        base: 0,   r: [52, 60], warn: [1.25, 0.8], hail: [],      giant: [],   slip: 7,   glacier: false, shard: false },
};
const LAYOUT = [
  { cx: 350, cy: 595, rx: 262, ry: 212, prof: 'calm' },
  { cx: 960, cy: 595, rx: 262, ry: 212, prof: 'volcano' },
  { cx: 1570, cy: 595, rx: 262, ry: 212, prof: 'glacier' },
];
const FINAL = { cx: 960, cy: 610, rx: 430, ry: 280, prof: 'final' };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

class Game {
  constructor(seed, winners) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed);
    this.winnersN = clamp(winners | 0 || 1, 1, 20);
    this.quota = Math.max(2, Math.ceil((this.winnersN + 4) / 3));
    this.phase = 'idle';            // idle | lobby | countdown | qual | transfer | final | won
    this.t = 0; this.gt = 0; this.playT = 0; this.cd = 0; this.tt = 0;
    this.players = []; this.byKey = new Map();
    this.meteors = []; this.events = []; this.mid = 0;
    this.alive = 0; this.startCount = 0; this.F = 0;
    this.timeScale = 1; this.winners = [];
    this.grid = new Map();
    const n = GW * GH;
    this.state = new Uint8Array(n);     // 0 water, 1 land, 2 sinking, 3 rising
    this.owner = new Int8Array(n).fill(-1);
    this.key = new Float32Array(n);
    this.shade = new Float32Array(n);
    this.sinkT = new Float32Array(n);
    for (let i = 0; i < n; i++) this.shade[i] = this.rng();
    this.islands = LAYOUT.map((L, i) => this.buildIsland(i, L, false));
    this.rollDanger();
  }

  computeQuotas() {
    const q0 = Math.max(2, Math.ceil((this.winnersN + 4) / 3));
    this.quota = q0;
    for (const isl of this.islands) if (isl.id < 3) isl.quota = isl.danger === 1 ? Math.round(q0 * 1.5) : isl.danger === 2 ? q0 : Math.max(1, Math.round(q0 * 0.5));
  }

  quotaSum() { return this.islands.reduce((s, i) => s + (i.id < 3 ? i.quota : 0), 0); }

  // Quotas above are absolute numbers tuned for a crowd. With a small roster an island
  // can start at or below its quota, and then the director has nothing to do: spawnAcc is
  // zeroed every frame and meteors in the air are purged, so the whole qualifier runs
  // empty whatever the danger level. Pull each quota under the island's own headcount so
  // every populated island still has someone to cull, keeping enough survivors for the
  // final. Crowds are untouched: there quota is already well below the headcount.
  fitQuotas() {
    const live = this.islands.filter(i => i.id < 3 && i.n > 0);
    if (!live.length) return;                       // no roster yet: base quotas stand
    // Never below 1: a populated island showing "пройдут 0" dooms whoever stands on it no
    // matter how well they play, and a lone player could not be culled without emptying the
    // island anyway. Such an island is simply already at quota, so it closes at once.
    for (const isl of live) isl.quota = clamp(Math.min(isl.quota, isl.n - 1), 1, isl.n);
    const sum = () => live.reduce((s, i) => s + i.quota, 0);
    const floor = Math.min(this.winnersN + 1, live.reduce((s, i) => s + i.n, 0));
    for (let g = 0; g < 60 && sum() < floor; g++) {
      // Raising a quota up to the island's headcount gives it a free pass, so spend those
      // raises on the thinnest islands first: a lone player could not be culled without
      // emptying the island anyway, while a two-player island still has a real round to play.
      let best = null;
      for (const isl of live) if (isl.quota < isl.n && (!best || isl.n < best.n || (isl.n === best.n && isl.n - isl.quota > best.n - best.quota))) best = isl;
      if (!best) break;
      best.quota++;
    }
  }

  rollDanger() {
    for (let k = 0; k < 50; k++) {
      for (const isl of this.islands) if (isl.id < 3) isl.danger = 1 + Math.floor(this.rng() * 3);
      this.computeQuotas();
      const lv = new Set(this.islands.filter(i => i.id < 3).map(i => i.danger));
      if (lv.size >= 2 && this.quotaSum() >= this.winnersN + 2) break;
    }
    for (const isl of this.islands) if (isl.id < 3) isl.hails = isl.prof.hail.concat(DANGER[isl.danger].hails).sort((a, b) => a - b);
    this.fitQuotas();
  }

  setWinners(n) {
    if (this.phase !== 'idle' && this.phase !== 'lobby') return;
    this.winnersN = clamp(n | 0, 1, 20);
    this.computeQuotas();
    if (this.quotaSum() < this.winnersN + 2) this.rollDanger();
    else this.fitQuotas();
  }

  buildIsland(id, L, rising) {
    const r = this.rng;
    const amps = [0, 0, 0.08, 0.06, 0.045, 0.03, 0.02, 0.014];
    const ph = amps.map(() => r() * TAU), ph2 = r() * TAU, ph3 = r() * TAU;
    const isl = {
      id, prof: PROFILES[L.prof], cx0: L.cx, cy0: L.cy, rx: L.rx, ry: L.ry, cx: L.cx, cy: L.cy,
      cells: [], n: 0, n0: 0, alive: 0, done: false, sinkS: 1.03, spawnAcc: 0,
      hails: PROFILES[L.prof].hail.slice(), giants: PROFILES[L.prof].giant.slice(),
    };
    const x0 = Math.max(0, Math.floor((L.cx - L.rx * 1.3) / CELL)), x1 = Math.min(GW - 1, Math.ceil((L.cx + L.rx * 1.3) / CELL));
    const y0 = Math.max(0, Math.floor((L.cy - L.ry * 1.3) / CELL)), y1 = Math.min(GH - 1, Math.ceil((L.cy + L.ry * 1.3) / CELL));
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const i = gy * GW + gx, cx = gx * CELL + CELL / 2, cy = gy * CELL + CELL / 2;
      const dx = (cx - L.cx) / L.rx, dy = (cy - L.cy) / L.ry, d = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
      let e = 1;
      for (let k = 2; k < amps.length; k++) e += amps[k] * Math.sin(k * a + ph[k]);
      const ratio = d / e;
      if (ratio < 1 && cy > 150 && this.state[i] === 0) {
        this.owner[i] = id;
        this.key[i] = ratio + 0.07 * Math.sin(a * 4 + ph2) + 0.05 * Math.sin(a * 9 + ph3) + (r() - 0.5) * 0.05;
        if (rising) { this.state[i] = 3; this.sinkT[i] = -ratio * 1.3 - r() * 0.15; }
        else this.state[i] = 1;
        isl.cells.push(i);
      }
    }
    this.centroid(isl);
    return isl;
  }

  centroid(isl) {
    let sx = 0, sy = 0, c = 0;
    for (const i of isl.cells) if (this.state[i] === 1) { sx += i % GW; sy += (i / GW) | 0; c++; }
    if (c) { isl.cx = (sx / c) * CELL + CELL / 2; isl.cy = (sy / c) * CELL + CELL / 2; }
  }

  cellAt(x, y) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return -1;
    return gy * GW + gx;
  }
  isLand(x, y) { const i = this.cellAt(x, y); return i >= 0 && (this.state[i] === 1 || this.state[i] === 2); }
  isSafe(x, y) { const i = this.cellAt(x, y); return i >= 0 && this.state[i] === 1; }

  randomPoint(isl, nx, ny, rad) {
    const r = this.rng;
    if (nx !== undefined) for (let k = 0; k < 10; k++) {
      const x = nx + (r() - 0.5) * 2 * rad, y = ny + (r() - 0.5) * 2 * rad;
      if (this.isSafe(x, y)) return { x, y };
    }
    for (let k = 0; k < 30; k++) {
      const i = isl.cells[Math.floor(r() * isl.cells.length)];
      if (i !== undefined && this.state[i] === 1) return { x: (i % GW) * CELL + CELL / 2, y: ((i / GW) | 0) * CELL + CELL / 2 };
    }
    return { x: isl.cx, y: isl.cy };
  }

  openLobby() { if (this.phase === 'idle') this.phase = 'lobby'; }

  leastIsland() {
    let best = 0;
    for (let i = 1; i < this.islands.length; i++) {
      const a = this.islands[i].n, b = this.islands[best].n;
      if (a < b || (a === b && this.rng() < 0.5)) best = i;
    }
    return best;
  }

  placeOn(p, isl) {
    const pt = this.randomPoint(isl);
    p.x = pt.x + (this.rng() - 0.5) * CELL; p.y = pt.y + (this.rng() - 0.5) * CELL;
    if (!this.isSafe(p.x, p.y)) { p.x = pt.x; p.y = pt.y; }
    p.vx = p.vy = 0; p.wx = p.x; p.wy = p.y;
  }

  // who: { key, display, platform } — key is the stable cross‑platform identity ("twitch:12345").
  // A bare string is accepted for local/bot players and becomes key "local:<lowercased>".
  // choice: 1..3, or 0/undefined for automatic (least populated island)
  addPlayer(who, choice) {
    const o = typeof who === 'string' ? { key: 'local:' + who.trim().toLowerCase(), display: who, platform: 'local' } : (who || {});
    const name = String(o.display || '').trim().slice(0, 25);
    const k = String(o.key || '').trim().toLowerCase();
    if (this.phase !== 'lobby' || !name || !k) return null;
    const c = parseInt(choice, 10);
    const old = this.byKey.get(k);
    const target = c >= 1 && c <= this.islands.length ? c - 1 : (old ? old.island : this.leastIsland());
    if (old) {
      if (old.island === target) return old;
      this.islands[old.island].n--; this.islands[old.island].alive--;
      old.island = target; this.islands[target].n++; this.islands[target].alive++;
      this.placeOn(old, this.islands[target]);
      this.computeQuotas(); this.fitQuotas();
      this.events.push({ type: 'move', p: old });
      return old;
    }
    const r = mulberry32(this.seed ^ hashStr(k));
    const p = {
      id: this.players.length, name, key: k, platform: o.platform || 'local',
      island: target, x: 0, y: 0, vx: 0, vy: 0, hue: hashStr(k + '#') % 360,
      speed: 72 + r() * 48, react: 0.12 + r() * 0.5, attn: 0.5 + r() * 0.45,
      alive: true, wx: 0, wy: 0, wt: r() * 2, waterT: 0, joinT: this.t, place: 0, phase: r() * TAU, hl: 0, fly: null,
    };
    this.placeOn(p, this.islands[target]);
    this.players.push(p); this.byKey.set(k, p);
    this.islands[target].n++; this.islands[target].alive++;
    this.alive++;
    this.computeQuotas(); this.fitQuotas();
    this.events.push({ type: 'join', p });
    return p;
  }

  // Accepts a key ("twitch:123") or a display name; keys are tried first.
  findPlayer(ref) {
    const q = String(ref || '').trim().toLowerCase();
    if (!q) return null;
    const hit = this.byKey.get(q) || this.byKey.get('local:' + q);
    if (hit) return hit;
    for (const p of this.players) if (p.name.toLowerCase() === q) return p;
    return null;
  }

  start() {
    if (this.phase !== 'lobby' || this.alive < 2) return false;
    if (this.winnersN >= this.alive) this.winnersN = this.alive - 1;
    this.phase = 'countdown'; this.cd = 3; this.startCount = this.alive;
    for (const isl of this.islands) { isl.n0 = isl.n; isl.alive = isl.n; if (isl.n0 === 0) isl.done = true; }
    this.computeQuotas(); this.fitQuotas();
    this.events.push({ type: 'countdown' });
    return true;
  }

  update(dt) {
    this.t += dt;
    const ph = this.phase;
    if (ph === 'idle' || ph === 'lobby') { this.updatePlayers(dt * 0.6, false); return; }
    if (ph === 'countdown') {
      this.cd -= dt; this.updatePlayers(dt, false);
      if (this.cd <= 0) { this.phase = 'qual'; this.gt = 0; this.playT = 0; this.events.push({ type: 'go' }); }
      return;
    }
    if (ph === 'won') { this.updateSink(dt); this.updatePlayers(dt * 0.5, false); return; }
    this.playT += dt;
    if (ph === 'qual') {
      this.gt += dt;
      for (const isl of this.islands) this.directorQual(isl, dt);
      this.updateMeteors(); this.updateSink(dt); this.updatePlayers(dt, true);
      if (this.phase === 'qual') this.checkIslands();
    } else if (ph === 'transfer') {
      this.gt += dt; this.tt += dt;
      if (this.tt >= 1.8 && !this.fin) {
        this.fin = this.buildIsland(3, FINAL, true);
        this.islands.push(this.fin);
        this.events.push({ type: 'ground' });
      }
      this.updateSink(dt); this.updatePlayers(dt, false);
      if (this.tt >= 4.4) {
        for (const p of this.players) if (p.alive) { p.fly = null; p.lift = 0; p.island = 3; }
        this.phase = 'final'; this.F = this.alive; this.finalT0 = this.gt; this.finalReal0 = this.playT; this.finalNext = this.gt + 0.9;
        this.fin.alive = this.alive; this.fin.n0 = this.alive;
        this.events.push({ type: 'final' });
      }
    } else if (ph === 'final') {
      const near = this.alive - this.winnersN <= 2;
      this.timeScale += ((near ? 0.6 : 1) - this.timeScale) * Math.min(1, dt * 3);
      const g = dt * this.timeScale;
      this.gt += g;
      this.directorFinal(g); this.updateMeteors(); this.updateSink(g); this.updatePlayers(g, true);
    }
  }

  notices(m, p) {
    if (m.kind === 'giant') return true;
    let h = Math.imul(m.id + 1, 2654435761) ^ Math.imul(p.id + 7, 40503);
    h = Math.imul(h ^ (h >>> 15), 2246822507); h ^= h >>> 13;
    return ((h >>> 0) / 4294967296) < p.attn;
  }

  updatePlayers(dt, lethal) {
    const B = 24, grid = this.grid; grid.clear();
    const list = [];
    for (const p of this.players) if (p.alive) {
      if (p.fly) { this.updateFly(p, dt); continue; }
      list.push(p);
      const k = ((p.x / B) | 0) + ((p.y / B) | 0) * 100;
      let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(p);
    }
    const r = this.rng, gt = this.gt;
    for (const p of list) {
      const isl = this.islands[p.island];
      if (!isl) continue;
      let fx = 0, fy = 0, fleeing = false;
      if (lethal) for (const m of this.meteors) {
        const age = gt - m.t0;
        if (age < p.react || !this.notices(m, p)) continue;
        const dx = p.x - m.x, dy = p.y - m.y, d = Math.hypot(dx, dy) || 0.01, R = m.r + 26;
        if (d < R) { const w = (R - d) / R + 0.4; fx += dx / d * w; fy += dy / d * w; fleeing = true; }
      }
      let dvx, dvy;
      if (fleeing) { const n = Math.hypot(fx, fy) || 1; dvx = fx / n * p.speed * 1.4; dvy = fy / n * p.speed * 1.4; }
      else {
        p.wt -= dt;
        let dx = p.wx - p.x, dy = p.wy - p.y, d = Math.hypot(dx, dy);
        if (d < 8 || p.wt <= 0) {
          const pt = this.randomPoint(isl, p.x, p.y, 150);
          p.wx = pt.x; p.wy = pt.y; p.wt = 2 + r() * 3;
          dx = p.wx - p.x; dy = p.wy - p.y; d = Math.hypot(dx, dy);
        }
        d = d || 1;
        dvx = dx / d * p.speed * 0.42; dvy = dy / d * p.speed * 0.42;
      }
      const ax = p.x + p.vx * 0.35, ay = p.y + p.vy * 0.35;
      if (!this.isSafe(ax, ay) || !this.isSafe(p.x, p.y)) {
        const cx = isl.cx - p.x, cy = isl.cy - p.y, n = Math.hypot(cx, cy) || 1;
        dvx = dvx * 0.3 + cx / n * p.speed; dvy = dvy * 0.3 + cy / n * p.speed;
        if (!fleeing) { p.wx = isl.cx; p.wy = isl.cy; }
      }
      let sx = 0, sy = 0;
      const gx = (p.x / B) | 0, gy = (p.y / B) | 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const a = grid.get(gx + ox + (gy + oy) * 100); if (!a) continue;
        for (const q of a) {
          if (q === p) continue;
          const dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy;
          if (d2 < 225 && d2 > 0.0001) { const d = Math.sqrt(d2), w = (15 - d) / 15; sx += dx / d * w; sy += dy / d * w; }
        }
      }
      const k = Math.min(1, dt * isl.prof.slip);
      p.vx += (dvx - p.vx) * k; p.vy += (dvy - p.vy) * k;
      p.x += (p.vx + sx * 70) * dt; p.y += (p.vy + sy * 70) * dt;
      if (lethal) {
        if (!this.isLand(p.x, p.y)) { p.waterT += dt; if (p.waterT > 0.4) this.kill(p, 'drown', -1); }
        else p.waterT = 0;
      }
    }
  }

  updateFly(p, dt) {
    const f = p.fly; f.t += dt;
    const u = clamp(f.t / f.dur, 0, 1), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    p.x = f.x0 + (f.x1 - f.x0) * e;
    p.y = f.y0 + (f.y1 - f.y0) * e - Math.sin(u * Math.PI) * 260;
    p.lift = Math.sin(u * Math.PI);
    if (u >= 1 && this.fin && this.isSafe(f.x1, f.y1)) {
      p.fly = null; p.lift = 0; p.island = 3; p.vx = p.vy = 0; p.wx = p.x; p.wy = p.y;
      this.events.push({ type: 'land', p });
    }
  }

  kill(p, cause, group) {
    if (!p.alive || this.alive <= this.winnersN) return false;
    p.alive = false; p.place = this.alive; this.alive--;
    const isl = this.islands[p.island]; if (isl) isl.alive--;
    this.events.push({ type: 'kill', p, cause, group });
    if (this.alive <= this.winnersN) this.finish();
    return true;
  }

  finish() {
    this.winners = this.players.filter(p => p.alive);
    for (const p of this.winners) { p.fly = null; p.lift = 0; }
    this.phase = 'won'; this.meteors = [];
    this.events.push({ type: 'win', list: this.winners });
  }

  spawn(isl, x, y, r, warn, kind, delay) {
    this.meteors.push({ id: this.mid++, island: isl.id, x, y, r, warn, t0: this.gt + (delay || 0), kind: kind || 'normal' });
  }

  pickAlive(id) {
    const a = this.players.filter(p => p.alive && p.island === id && !p.fly);
    return a.length ? a[Math.floor(this.rng() * a.length)] : null;
  }

  updateMeteors() {
    const due = [], keep = [];
    for (const m of this.meteors) (this.gt - m.t0 >= m.warn ? due : keep).push(m);
    this.meteors = keep;
    for (const m of due) { if (this.phase !== 'qual' && this.phase !== 'final') break; this.impact(m); }
  }

  impact(m) {
    let victims = [];
    for (const p of this.players) if (p.alive && !p.fly) {
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < m.r + 6) victims.push({ p, d });
    }
    const isl0 = this.islands[m.island];
    if (this.phase === 'qual' && isl0 && victims.length >= 2 && victims.length >= isl0.alive) { victims.sort((x, y) => y.d - x.d); victims.shift(); }
    const maxKill = this.alive - this.winnersN;
    if (victims.length > maxKill) { victims.sort((a, b) => b.d - a.d); victims = victims.slice(victims.length - maxKill); }
    victims.sort((a, b) => a.d - b.d);
    this.events.push({ type: 'impact', x: m.x, y: m.y, r: m.r, kind: m.kind, island: m.island, id: m.id });
    for (const v of victims) this.kill(v.p, 'burn', m.id);
    const isl = this.islands[m.island];
    if (m.kind === 'shard' && isl && !isl.done && (this.phase === 'qual' || this.phase === 'final')) {
      const a0 = this.rng() * TAU;
      for (let k = 0; k < 3; k++) {
        const a = a0 + k * TAU / 3;
        this.spawn(isl, m.x + Math.cos(a) * m.r * 1.35, m.y + Math.sin(a) * m.r * 1.35, m.r * 0.5, 0.75, 'small', 0);
      }
    }
  }

  directorQual(isl, dt) {
    if (isl.done) return;
    const a = isl.alive, n = Math.max(1, isl.n0), q = isl.quota, P = isl.prof, gt = this.gt, r = this.rng, D = DANGER[isl.danger];
    const tp = 0.2 + 0.9 * Math.sqrt(a / n);
    if (P.glacier) {
      const tS = Math.min(1.03 - 0.8 * clamp((gt - 3) / 40, 0, 1), tp + 0.05);
      if (tS < isl.sinkS) isl.sinkS = Math.max(tS, isl.sinkS - 0.055 * dt);
    } else {
      // tp alone only shrinks an island once people start dying, so a sparse island (a/n stays
      // ~1 while two players dodge on a full-size arena) never closes in. Squeeze it on the
      // clock as well; in a crowd tp is already the lower of the two, so nothing changes there.
      const tC = 1.03 - 0.55 * clamp((gt - 10) / (QMAX - 10), 0, 1);
      const tS = Math.min(tp, tC);
      if (gt > 8 && tS < isl.sinkS) isl.sinkS = Math.max(tS, isl.sinkS - 0.035 * dt);
    }
    if (gt < 3) return;
    const u = (gt - 3) / (QT - 3);
    if (gt > QMAX) isl.spawnAcc += 5 * dt;
    else if (a <= q) { isl.spawnAcc = 0; if (this.meteors.some(m => m.island === isl.id)) this.meteors = this.meteors.filter(m => m.island !== isl.id); }
    else {
      const sh = u <= 1 ? P.shape(clamp(u, 0, 1)) : u;
      const target = Math.max(q, n * Math.pow(q / n, sh));
      const ratio = a / target;
      isl.spawnAcc += P.base * Math.pow(clamp(ratio, 0.25, 3), 2) * dt;
    }
    while (isl.spawnAcc >= 1) {
      isl.spawnAcc -= 1;
      const p = this.pickAlive(isl.id); if (!p) break;
      const kind = P.shard && a < 30 && r() < 0.3 ? 'shard' : 'normal';
      const warn = (P.warn[0] + (P.warn[1] - P.warn[0]) * clamp(u, 0, 1)) * D.warn;
      this.spawn(isl, p.x + (r() - 0.5) * 55, p.y + (r() - 0.5) * 55, (P.r[0] + r() * (P.r[1] - P.r[0])) * D.r, warn, kind, 0);
    }
    if (isl.hails.length && gt >= isl.hails[0]) {
      isl.hails.shift();
      if (a > q + 6) {
        const cnt = Math.round(clamp(a * 0.08, 5, 14));
        for (let k = 0; k < cnt; k++) { const p = this.pickAlive(isl.id); if (p) this.spawn(isl, p.x + (r() - 0.5) * 50, p.y + (r() - 0.5) * 50, 28 * D.r, 1.0, 'small', k * 0.07); }
        this.events.push({ type: 'wave', label: 'ГРАД', island: isl.id });
      }
    }
    if (isl.giants.length && gt >= isl.giants[0]) {
      isl.giants.shift();
      if (a > q + 4 && isl.danger >= 2) {
        let sx = 0, sy = 0, c = 0;
        for (const p of this.players) if (p.alive && p.island === isl.id) { sx += p.x; sy += p.y; c++; }
        if (c) { this.spawn(isl, sx / c + (r() - 0.5) * 50, sy / c + (r() - 0.5) * 50, 105, 2.0, 'giant', 0); this.events.push({ type: 'wave', label: 'ГИГАНТ', island: isl.id }); }
      }
    }
  }

  checkIslands() {
    let all = true;
    // An island at its quota will never spawn again (directorQual zeroes spawnAcc and clears
    // the sky for it), so holding it until QMIN was pure dead air — most visible on a small
    // roster, where an island can start already at quota. Close it at once: whoever is left
    // on it has qualified.
    for (const isl of this.islands) {
      if (!isl.done && (isl.alive === 0 || isl.alive <= isl.quota)) {
        isl.done = true;
        this.meteors = this.meteors.filter(m => m.island !== isl.id);
        this.events.push({ type: 'islandDone', island: isl.id, count: isl.alive });
      }
      if (!isl.done) all = false;
    }
    if (all) this.beginTransfer();
  }

  beginTransfer() {
    const fin = this.players.filter(p => p.alive);
    if (fin.length <= this.winnersN) { this.finish(); return; }
    this.phase = 'transfer'; this.tt = 0; this.meteors = [];
    for (const isl of this.islands) for (const i of isl.cells) if (this.state[i] > 0) { this.state[i] = 2; this.sinkT[i] = -0.2 - this.rng() * 0.6; }
    for (const isl of this.islands) isl.sinkS = -9;
    const n = fin.length;
    fin.forEach((p, k) => {
      const a = -Math.PI / 2 + k * TAU / n + (this.rng() - 0.5) * 0.3, rr = 0.35 + this.rng() * 0.15;
      p.fly = { x0: p.x, y0: p.y, x1: FINAL.cx + Math.cos(a) * FINAL.rx * rr, y1: FINAL.cy + Math.sin(a) * FINAL.ry * rr, t: -0.15 - k * 0.06, dur: 2.6 };
    });
    this.events.push({ type: 'transfer', count: n });
  }

  directorFinal(dt) {
    const fin = this.fin, a = this.alive, w = this.winnersN, gt = this.gt, r = this.rng;
    const k = gt - this.finalT0;
    const tS = 0.22 + 0.85 * Math.sqrt(a / this.F);
    if (tS < fin.sinkS) fin.sinkS = Math.max(tS, fin.sinkS - 0.03 * dt);
    if (this.playT - this.finalReal0 > 40) {
      fin.spawnAcc += 5 * dt;
      while (fin.spawnAcc >= 1) { fin.spawnAcc--; const p = this.pickAlive(3); if (p) this.spawn(fin, p.x, p.y, 60, 0.8, 'normal', 0); }
      return;
    }
    if (gt >= this.finalNext) {
      const p = this.pickAlive(3);
      if (p) this.spawn(fin, p.x + (r() - 0.5) * 16, p.y + (r() - 0.5) * 16, 52 + k * 3, Math.max(0.75, 1.25 - k * 0.03), 'normal', 0);
      const crowd = 1 + (a - w) / 5;
      this.finalNext = gt + Math.max(0.45, 1.25 - k * 0.04) / crowd;
    }
  }

  updateSink(dt) {
    for (const isl of this.islands) {
      let changed = false;
      for (const i of isl.cells) {
        const s = this.state[i];
        if (s === 1 && this.key[i] > isl.sinkS) { this.state[i] = 2; this.sinkT[i] = 0; }
        else if (s === 2) { this.sinkT[i] += dt; if (this.sinkT[i] > 0.9) { this.state[i] = 0; this.owner[i] = -1; changed = true; } }
        else if (s === 3) { this.sinkT[i] += dt; if (this.sinkT[i] >= 0) { this.state[i] = 1; changed = true; } }
      }
      if (changed) {
        isl.cells = isl.cells.filter(i => this.state[i] > 0);
        this.centroid(isl);
        this.events.push({ type: 'ground' });
      }
    }
  }
}

export { W, H, CELL, GW, GH, TAU, QT, DANGER, PROFILES, LAYOUT, FINAL, mulberry32, hashStr, clamp, Game };
