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
check('!me is ignored', got.length === 0, JSON.stringify(got));

/* ---- unknown commands and plain chat are ignored ---- */
got.length = 0;
await say('alice', 'hello everyone');
await say('alice', '!notacommand');
await say('streamer', '!meteor nonsense', { broadcaster: true });
await sleep(250);
check('plain chat and unknown commands are ignored', got.length === 0, JSON.stringify(got));

/* ---- winners ---- */
got.length = 0;
await say('streamer', '!meteor winners 5', { broadcaster: true });
await sleep(200);
check('!meteor winners N propagates', cmds('winners')[0] && cmds('winners')[0].value === 5);
await say('streamer', '!meteor winners 99', { broadcaster: true });
await sleep(200);
check('out-of-range winner counts are rejected', cmds('winners').length === 1);

/* ---- go ---- */
got.length = 0;
await say('mody', '!meteor go', { mod: true });
await sleep(200);
check('a mod can force the start', cmds('go').length === 1);

/* ---- overlay reports flow back into the session ---- */
await post('/api/report', { type: 'phase', phase: 'qual', alive: 7, winners: 5, islands: [] });
await sleep(150);
let st = await fetch(BASE + '/api/state').then(r => r.json());
check('overlay phase report updates the session', st.session.phase === 'qual' && st.session.alive === 7, st.session.phase);

await post('/api/report', { type: 'win', list: [{ key: 'twitch:alice', display: 'alice', place: 1 }] });
await sleep(150);
st = await fetch(BASE + '/api/state').then(r => r.json());
check('win report is recorded', st.session.phase === 'won' && st.session.lastWinners.length === 1);

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

/* ---- static files and the traversal guard ---- */
for (const [path, want] of [['/overlay.html', 200], ['/control.html', 200], ['/js/core.js', 200], ['/nope.html', 404]]) {
  const r = await fetch(BASE + path);
  check(`GET ${path} -> ${want}`, r.status === want, `got ${r.status}`);
}
const esc = await fetch(BASE + '/js/%2e%2e/%2e%2e/package.json');
check('path traversal is blocked', esc.status === 404 || esc.status === 403, `got ${esc.status}`);

/* ---- malformed input ---- */
const bad = await fetch(BASE + '/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
check('invalid JSON is a 500/400, not a crash', bad.status >= 400 && bad.status < 600, `got ${bad.status}`);
const unknown = await post('/api/cmd', { name: 'launch_missiles' });
check('unknown command is refused', unknown.ok === false);

await post('/api/cmd', { name: 'reset' });
try { await reader.cancel(); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
