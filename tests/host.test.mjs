/* End-to-end test of the host pipeline: a fake overlay subscribes over SSE,
   synthetic chat goes in through /api/chat/inject, and we assert what comes out.
   Run the host first (npm start), then: node tests/host.test.mjs */
const BASE = process.env.BASE || 'http://127.0.0.1:7777';

const got = [];
let pass = 0, fail = 0;

function check(name, ok, extra) {
  (ok ? pass++ : fail++);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`);
}

const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}).then(r => r.json());

const say = (nick, text, roles) => post('/api/chat/inject', {
  platform: 'twitch', userId: nick, display: nick, text, roles: roles || {},
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const of = t => got.filter(m => m.t === t);
const cmds = name => got.filter(m => m.t === 'cmd' && m.name === name);
/* The host pushes a `phase` heartbeat every second while the lobby is open, so
   "nothing happened" means no command and no join — not a silent stream. */
const acted = () => got.filter(m => m.t !== 'phase');

/* ---- fake overlay on the SSE stream ---- */
async function subscribe() {
  const res = await fetch(`${BASE}/events?role=overlay`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const c of chunks) {
        const line = c.split('\n').find(l => l.startsWith('data: '));
        if (line) got.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  return reader;
}

const reader = await subscribe();
await sleep(300);
check('overlay receives hello with a session snapshot', of('hello').length === 1 && !!of('hello')[0].session);

/* ---- admin start ---- */
await post('/api/cmd', { name: 'reset' });
got.length = 0;
await say('streamer', '!meteor start', { broadcaster: true });
await sleep(250);
const start = cmds('start')[0];
check('!meteor start opens a lobby', !!start);
check('start carries a host-owned seed', !!start && start.seed > 0, start && `seed=${start.seed}`);

/* ---- a non-mod must not be able to start ---- */
got.length = 0;
await say('randomviewer', '!meteor reset', {});
await sleep(200);
check('a viewer cannot run admin commands', cmds('reset').length === 0);

/* ---- joins ---- */
got.length = 0;
for (const n of ['alice', 'bob', 'carol']) await say(n, '!join 2');
await sleep(250);
check('three !join become three join messages', of('join').length === 3, `got ${of('join').length}`);
check('island choice is passed through', of('join').every(j => j.choice === 2));
check('identity is namespaced by platform', of('join').every(j => j.key.startsWith('twitch:')), of('join')[0] && of('join')[0].key);

/* ---- dedupe: the same text twice in a row is one join ---- */
got.length = 0;
await say('dave', '!join 1');
await say('dave', '!join 1');
await sleep(250);
check('an identical repeat is deduped', of('join').length === 1, `got ${of('join').length}`);

/* ---- per-user rate limit: 3 per 10s by default ---- */
got.length = 0;
for (let i = 1; i <= 6; i++) await say('spammer', `!join ${(i % 3) + 1}`);
await sleep(300);
check('per-user rate limit caps the burst', of('join').length <= 3, `${of('join').length} joins let through`);

/* ---- !me was removed and must now be inert ---- */
got.length = 0;
await say('alice', '!me');
await sleep(200);
check('!me is ignored', acted().length === 0, JSON.stringify(acted()));

/* ---- unknown commands and plain chat are ignored ---- */
got.length = 0;
await say('alice', 'hello everyone');
await say('alice', '!notacommand');
await say('streamer', '!meteor nonsense', { broadcaster: true });
await sleep(250);
check('plain chat and unknown commands are ignored', acted().length === 0, JSON.stringify(acted()));

/* ---- winners ---- */
got.length = 0;
await say('streamer', '!meteor winners 5', { broadcaster: true });
await sleep(200);
check('!meteor winners N propagates', cmds('winners')[0] && cmds('winners')[0].value === 5);
await say('streamer', '!meteor winners 99', { broadcaster: true });
await sleep(200);
check('out-of-range winner counts are rejected', cmds('winners').length === 1);

/* ---- go: хост закрывает набор и сам ведёт матч ---- */
got.length = 0;
await say('mody', '!meteor go', { mod: true });
await sleep(300);
const seal = cmds('seal')[0], match = cmds('match')[0];
check('a mod can close the lobby', !!seal && seal.players >= 2, JSON.stringify(seal));
check('the host hands the overlay a finished match setup', !!match && match.params && match.params.roster.length === seal.players);
check('the match seed comes after the roster is sealed', !!match && got.indexOf(seal) < got.indexOf(match));
let st = await fetch(BASE + '/api/state').then(r => r.json());
check('the host runs the match itself', ['countdown', 'qual'].includes(st.session.phase), st.session.phase);

/* ---- отчёты оверлея больше ничего не решают ---- */
await post('/api/report', { type: 'phase', phase: 'won', alive: 1, winners: 5, islands: [] });
await post('/api/report', { type: 'win', list: [{ key: 'twitch:alice', display: 'alice', place: 1 }] });
await sleep(150);
st = await fetch(BASE + '/api/state').then(r => r.json());
check('an overlay report cannot end the match', st.session.phase !== 'won' && st.session.lastWinners.length === 0, st.session.phase);
const rec = await fetch(BASE + '/api/draw').then(r => r.json());
check('the draw record is served to the verify page', rec.ok && rec.record.roster.length === seal.players && !!rec.record.seed);

/* ---- resync: a reconnecting overlay gets the roster back ---- */
await post('/api/cmd', { name: 'reset' });
// a fresh nick: "streamer" has already spent its command budget for this window
await say('streamer2', '!meteor start', { broadcaster: true });
await sleep(150);
for (const n of ['eve', 'frank']) await say(n, '!join 3');
await sleep(250);
const r2 = await fetch(`${BASE}/events?role=overlay`);
const t2 = await r2.body.getReader().read();
const hello2 = JSON.parse(new TextDecoder().decode(t2.value).split('\n').find(l => l.startsWith('data: ')).slice(6));
check('a fresh overlay is handed the lobby roster', hello2.session.open && hello2.session.roster.length === 2,
  `roster=${(hello2.session.roster || []).map(p => p.display).join(',')}`);
check('resync carries the same seed', hello2.session.seed > 0);

/* ---- restart keeping the roster ---- */
await post('/api/cmd', { name: 'reset' });
got.length = 0;
await post('/api/cmd', { name: 'start' });
await sleep(150);
await say('gina', '!join 2');          // explicit island
await say('hugo', '!join');            // automatic — the host decides
await sleep(250);
const hugoSeat = of('join').find(j => j.key === 'twitch:hugo');
check('the host seats an automatic join itself', hugoSeat && hugoSeat.island >= 1, JSON.stringify(hugoSeat));

got.length = 0;
await post('/api/cmd', { name: 'start', keep: true });
await sleep(250);
const again = cmds('start')[0];
check('a keep-restart re-opens the lobby', !!again && again.keep === true);
check('the keep-restart rolls a new seed', !!again && again.seed > 0 && again.seed !== start.seed);
const seats = of('join');
check('kept players are replayed as joins', seats.length === 2, `got ${seats.length}`);
check('an explicit island survives the restart',
  seats.some(j => j.key === 'twitch:gina' && j.island === 2), JSON.stringify(seats));
check('an automatic island survives the restart',
  seats.some(j => j.key === 'twitch:hugo' && hugoSeat && j.island === hugoSeat.island), JSON.stringify(seats));
st = await fetch(BASE + '/api/state').then(r => r.json());
check('the roster is not emptied by a keep-restart', st.session.players === 2, `players=${st.session.players}`);
check('the keep-restart leaves the lobby open', st.session.phase === 'lobby' && st.session.open === true);

/* ---- a plain start still wipes the roster ---- */
await post('/api/cmd', { name: 'start' });
await sleep(150);
st = await fetch(BASE + '/api/state').then(r => r.json());
check('a plain start still clears the roster', st.session.players === 0, `players=${st.session.players}`);

/* ---- !meteor restart keeps the roster too ---- */
await say('ivan', '!join 3');
await sleep(200);
got.length = 0;
await say('streamer3', '!meteor restart', { broadcaster: true });
await sleep(250);
check('!meteor restart keeps the players', cmds('start')[0] && cmds('start')[0].keep === true
  && of('join').some(j => j.key === 'twitch:ivan' && j.choice === 3), JSON.stringify(got));

/* ---- static files and the traversal guard ---- */
for (const [path, want] of [['/overlay.html', 200], ['/control.html', 200], ['/verify.html', 200], ['/js/core.js', 200], ['/js/draw.js', 200], ['/nope.html', 404]]) {
  const r = await fetch(BASE + path);
  check(`GET ${path} -> ${want}`, r.status === want, `got ${r.status}`);
}
const esc = await fetch(BASE + '/js/%2e%2e/%2e%2e/package.json');
check('path traversal is blocked', esc.status === 404 || esc.status === 403, `got ${esc.status}`);

/* ---- доступ к хосту: только своя машина ----

   С transport "webhook" стример выставляет этот порт туннелем в интернет, и
   тогда чужой Host — это зритель, нашедший адрес. Ему нельзя ни панель, ни
   /api/state (там живой сид лобби), ни inject с правами ведущего. Заголовок
   Host через fetch не подменить, поэтому запрос собираем вручную. */
import { request } from 'node:http';

function raw(method, path, { host, origin, body } = {}) {
  const u = new URL(BASE + path);
  return new Promise((ok, fail) => {
    const headers = { 'content-type': 'application/json' };
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, res => {
      let t = ''; res.on('data', c => t += c); res.on('end', () => ok({ status: res.statusCode, text: t }));
    });
    req.on('error', fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

for (const [path, method, body] of [
  ['/api/state', 'GET', undefined],
  ['/api/cmd', 'POST', { name: 'reset' }],
  ['/api/chat/inject', 'POST', { platform: 'twitch', userId: 'x', display: 'x', text: '!meteor go' }],
  ['/api/report', 'POST', { type: 'win', list: [{ display: 'cheater' }] }],
  ['/events', 'GET', undefined],
  ['/control.html', 'GET', undefined],
]) {
  const r = await raw(method, path, { host: 'meteor.trycloudflare.com', body });
  check(`туннельный Host отбит: ${method} ${path}`, r.status === 403, `got ${r.status}`);
}
const okHost = await raw('GET', '/api/state', { host: '127.0.0.1:' + new URL(BASE).port });
check('своя машина проходит', okHost.status === 200, `got ${okHost.status}`);

// Ссылка из чата, по которой перешёл стример: Host свой, Origin чужой.
const csrf = await raw('POST', '/api/cmd', { origin: 'https://clips.example', body: { name: 'reset' } });
check('POST с чужим Origin отбит (ссылка из чата)', csrf.status === 403, `got ${csrf.status}`);
const sameOrigin = await raw('POST', '/api/cmd', { origin: BASE, body: { name: 'winners', value: 2 } });
check('свой Origin проходит', sameOrigin.status === 200, `got ${sameOrigin.status}`);

// Вебхук Kick — единственный маршрут снаружи; без подписи он отбивается уже
// адаптером, но не приглашением «forbidden».
const hook = await raw('POST', '/webhooks/kick', { host: 'meteor.trycloudflare.com', body: {} });
check('вебхук Kick снаружи не блокируется заголовком Host', hook.status !== 403, `got ${hook.status}`);

/* ---- malformed input ---- */
const bad = await fetch(BASE + '/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
check('invalid JSON is a 500/400, not a crash', bad.status >= 400 && bad.status < 600, `got ${bad.status}`);
const unknown = await post('/api/cmd', { name: 'launch_missiles' });
check('unknown command is refused', unknown.ok === false);

await post('/api/cmd', { name: 'reset' });
try { await reader.cancel(); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
