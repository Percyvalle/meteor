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
