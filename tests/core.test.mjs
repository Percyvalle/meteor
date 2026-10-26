import { Game } from '../public/js/core.js';

// A full match, headless, to prove the key/display refactor did not break the sim.
const g = new Game(12345, 3);
g.openLobby();
let added = 0;
for (let i = 0; i < 120; i++) {
  const platform = i % 2 ? 'twitch' : 'kick';
  const p = g.addPlayer({ key: `${platform}:${i}`, display: `user${i}`, platform }, i % 4);
  if (p) added++;
}
console.log('added:', added, 'alive:', g.alive);

// same nick on both platforms must be two distinct players
const a = g.addPlayer({ key: 'twitch:999', display: 'SameNick', platform: 'twitch' }, 1);
const b = g.addPlayer({ key: 'kick:999', display: 'SameNick', platform: 'kick' }, 1);
console.log('cross-platform nick collision avoided:', a !== b && a && b ? 'yes' : 'NO');

// re-join switches island, does not duplicate
const before = g.alive;
g.addPlayer({ key: 'twitch:1', display: 'user1', platform: 'twitch' }, 3);
console.log('re-join kept roster size:', g.alive === before ? 'yes' : 'NO');

// lookup by key and by display name
console.log('findPlayer by key:', !!g.findPlayer('twitch:5'), '| by display:', !!g.findPlayer('user5'));

console.log('start:', g.start(), 'phase:', g.phase);
let t = 0;
const dt = 1 / 60;
const seen = new Set();
while (g.phase !== 'won' && t < 400) { g.update(dt); seen.add(g.phase); t += dt; }
console.log('phases visited:', [...seen].join(' -> '));
console.log('finished at t=' + t.toFixed(1) + 's phase=' + g.phase);
console.log('winners:', g.winners.length, g.winners.map(p => `${p.platform}/${p.name}`).join(', '));
const places = g.players.filter(p => !p.alive).map(p => p.place);
console.log('all dead players got a place:', places.every(n => n > 0) ? 'yes' : 'NO');

// determinism: same seed + same joins => same winners
function run() {
  const x = new Game(777, 2); x.openLobby();
  for (let i = 0; i < 60; i++) x.addPlayer({ key: 'twitch:' + i, display: 'u' + i, platform: 'twitch' }, 0);
  x.start();
  let tt = 0; while (x.phase !== 'won' && tt < 400) { x.update(1 / 60); tt += 1 / 60; }
  return x.winners.map(p => p.key).join('|');
}
const r1 = run(), r2 = run();
console.log('deterministic:', r1 === r2 ? 'yes (' + r1 + ')' : 'NO\n  ' + r1 + '\n  ' + r2);

// A minimal roster must still get a real match: an island that is already at (or under) its
// quota has nothing left to spawn, so it must close at once and send its players to the final
// instead of standing empty for the rest of the qualifier.
let smallOk = true;
for (const [N, W] of [[2, 1], [3, 1], [4, 1], [4, 3], [5, 2], [6, 1], [8, 3], [12, 2], [40, 3]]) {
  for (let s = 0; s < 6; s++) {
    const x = new Game(4100 + s * 13, W); x.openLobby();
    for (let i = 0; i < N; i++) x.addPlayer({ key: 'twitch:' + i, display: 'u' + i, platform: 'twitch' }, 0);
    x.start();
    let tt = 0, worst = 0; const idle = [0, 0, 0];
    while (x.phase !== 'won' && tt < 200) {
      const qual = x.phase === 'qual';
      x.update(1 / 60); tt += 1 / 60;
      // an island with players on it, not yet closed, and no meteor of its own
      if (qual) for (const isl of x.islands) {
        if (isl.id > 2) continue;
        if (isl.done || isl.alive === 0 || x.meteors.some(m => m.island === isl.id)) { idle[isl.id] = 0; continue; }
        idle[isl.id] += 1 / 60; if (idle[isl.id] > worst) worst = idle[isl.id];
      }
      x.events.length = 0;
    }
    const bad = worst > 5 || tt > 90 || x.phase !== 'won' || x.winners.length !== W;
    if (bad) { smallOk = false; console.log(`  N=${N} W=${W} seed=${4100 + s * 13}: idle island=${worst.toFixed(1)}s dur=${tt.toFixed(1)}s phase=${x.phase} winners=${x.winners.length}`); }
  }
}
console.log('no island stands idle, any roster size:', smallOk ? 'yes' : 'NO');

// A populated island must never advertise "пройдут 0" — that dooms whoever stands on it.
let quotaOk = true;
for (const N of [1, 2, 3, 4, 5, 6, 8, 12, 40, 120]) for (const W of [1, 2, 3]) {
  for (let s = 0; s < 8; s++) {
    const x = new Game(6200 + s * 29, W); x.openLobby();
    for (let i = 0; i < N; i++) x.addPlayer({ key: 'twitch:' + i, display: 'u' + i, platform: 'twitch' }, 0);
    const lobby = x.islands.filter(i => i.id < 3 && i.n > 0 && i.quota < 1);
    if (N > W) x.start();
    const started = x.islands.filter(i => i.id < 3 && i.n0 > 0 && i.quota < 1);
    if (lobby.length || started.length) { quotaOk = false; console.log(`  N=${N} W=${W} seed=${6200 + s * 29}: ` + x.islands.filter(i => i.id < 3).map(i => `${i.n}>${i.quota}`).join(' ')); }
  }
}
console.log('no populated island has a zero quota:', quotaOk ? 'yes' : 'NO');
