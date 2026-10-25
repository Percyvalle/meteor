/* End-to-end test of the relay: a fake agent dials in over SSE, signed Kick
   webhooks go to the public endpoint, and we assert each one lands on the right
   agent — or is rejected.

   Starts its own relay on a spare port with its own state file, so it never
   touches a running instance. */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createSign, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8099;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = resolve(ROOT, '.relay-state.json');
const BACKUP = STATE + '.testbak';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

/* Two streamers: one linked to an agent, one nobody owns. */
const A = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex'), bid: 111111, channel: 'streamer_one' };
const B = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex'), bid: 222222, channel: 'streamer_two' };

/* Preserve any real state file; the test writes its own and restores afterwards. */
if (existsSync(STATE)) writeFileSync(BACKUP, readFileSync(STATE));
const hash = k => createHash('sha256').update(k).digest('hex');

writeFileSync(STATE, JSON.stringify({
  agents: {
    [A.id]: {
      id: A.id, keyHash: hash(A.key), createdAt: Date.now(),
      broadcasterUserId: A.bid, channel: A.channel,
      tokens: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600e3, scope: 'user:read channel:read chat:write events:subscribe' },
    },
    [B.id]: { id: B.id, keyHash: hash(B.key), createdAt: Date.now(), broadcasterUserId: 0, channel: '' },
  },
  byBroadcaster: { [String(A.bid)]: A.id },
}, null, 2));

writeFileSync(resolve(ROOT, '.relay-test.config.json'), JSON.stringify({
  port: PORT, publicUrl: BASE, clientId: 'test', clientSecret: 'test',
}));

const relay = spawn(process.execPath, [resolve(ROOT, 'relay/index.mjs')], {
  cwd: ROOT,
  env: { ...process.env, RELAY_PORT: String(PORT), RELAY_PUBLIC_URL: BASE, KICK_CLIENT_ID: 'test', KICK_CLIENT_SECRET: 'test', KICK_PUBLIC_KEY_PEM: PEM, LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stdout.on('data', () => {});
relay.stderr.on('data', d => process.stderr.write(d));

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/status'); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

function cleanup() {
  try { relay.kill(); } catch {}
  try {
    if (existsSync(BACKUP)) { writeFileSync(STATE, readFileSync(BACKUP)); rmSync(BACKUP); }
    else rmSync(STATE, { force: true });
    rmSync(resolve(ROOT, '.relay-test.config.json'), { force: true });
  } catch {}
}

/* ---- fake agent: a streamer's local host ---- */
function agentConnect(who) {
  const got = [];
  const ctrl = new AbortController();
  const ready = (async () => {
    const r = await fetch(`${BASE}/agent/events?agent=${who.id}`, {
      headers: { authorization: `Bearer ${who.key}`, accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('status ' + r.status);
    (async () => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
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
    return r.status;
  })();
  return { got, ready, close: () => ctrl.abort() };
}

function signedPost(body, over = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const id = over.id ?? 'm-' + randomBytes(6).toString('hex');
  const ts = over.ts ?? new Date().toISOString();
  const sig = over.sig ?? createSign('RSA-SHA256')
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw])).sign(privateKey).toString('base64');
  return fetch(BASE + '/webhooks/kick', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'kick-event-message-id': id,
      'kick-event-message-timestamp': ts,
      'kick-event-signature': sig,
      'kick-event-type': over.type ?? 'chat.message.sent',
    },
    body: raw,
  }).then(async r => ({ status: r.status, text: await r.text(), id }));
}

const chat = (bid, text, sender = {}) => ({
  message_id: randomBytes(6).toString('hex'),
  broadcaster: { user_id: bid, slug: 'whatever' },
  sender: {
    user_id: sender.user_id ?? 5000,
    username: sender.username ?? 'Viewer',
    slug: sender.slug ?? 'viewer',
    identity: { badges: (sender.badges || []).map(t => ({ type: t })) },
  },
  content: text,
});

/* ---------------- run ---------------- */

try {
  if (!await waitUp()) { console.log('релей не поднялся'); cleanup(); process.exit(1); }

  /* --- agent auth --- */
  const bad = await fetch(`${BASE}/agent/events?agent=${A.id}`, { headers: { authorization: 'Bearer ' + 'z'.repeat(64) } });
  check('чужой ключ к существующему агенту отвергается', bad.status === 401, `status ${bad.status}`);
  try { await bad.body.cancel(); } catch {}

  const a = agentConnect(A);
  await a.ready;
  await sleep(300);
  check('агент подключается и получает hello', a.got[0] && a.got[0].t === 'hello', JSON.stringify(a.got[0] || null));
  check('hello несёт привязанный канал', a.got[0] && a.got[0].agent.channel === A.channel && a.got[0].agent.linked === true);

  /* --- routing --- */
  a.got.length = 0;
  let r = await signedPost(chat(A.bid, '!join 2'));
  await sleep(250);
  check('подписанное событие принято', r.status === 200, `${r.status} ${r.text}`);
  check('событие доставлено нужному агенту', a.got.length === 1 && a.got[0].t === 'chat' && a.got[0].msg.text === '!join 2',
    JSON.stringify(a.got[0] || null));
  check('сообщение уже нормализовано', a.got[0] && a.got[0].msg.platform === 'kick' && a.got[0].msg.userId === 5000);

  /* --- isolation between streamers --- */
  a.got.length = 0;
  r = await signedPost(chat(B.bid, '!join 1'));
  await sleep(250);
  check('событие чужого канала не попадает к агенту', a.got.length === 0, JSON.stringify(a.got));
  check('непривязанный канал подтверждается, а не ретраится', r.status === 200 && r.text === 'unlinked', `${r.status} ${r.text}`);

  /* --- roles --- */
  a.got.length = 0;
  await signedPost(chat(A.bid, '!meteor go', { user_id: 9, username: 'Mod', badges: ['moderator'] }));
  await sleep(250);
  check('бейдж модератора доезжает до агента', a.got[0] && a.got[0].msg.roles.mod === true);

  /* --- security --- */
  a.got.length = 0;
  r = await signedPost(chat(A.bid, '!meteor reset'), { sig: Buffer.from('forged').toString('base64') });
  await sleep(200);
  check('поддельная подпись отвергается 403', r.status === 403, `status ${r.status}`);
  check('поддельное событие не доставляется', a.got.length === 0);

  r = await signedPost(chat(A.bid, 'старое'), { ts: new Date(Date.now() - 20 * 60e3).toISOString() });
  check('протухший таймстамп отвергается 400', r.status === 400, `status ${r.status}`);

  /* --- replay --- */
  a.got.length = 0;
  const dupId = 'dup-' + randomBytes(4).toString('hex');
  const first = await signedPost(chat(A.bid, '!join 3'), { id: dupId });
  const again = await signedPost(chat(A.bid, '!join 3'), { id: dupId });
  await sleep(250);
  check('повтор подтверждается, но не дублируется',
    first.status === 200 && again.status === 200 && again.text === 'duplicate' && a.got.length === 1,
    `доставлено ${a.got.length}`);

  /* --- link flow --- */
  const link = await fetch(`${BASE}/agent/link?agent=${B.id}`, { method: 'POST', headers: { authorization: `Bearer ${B.key}` } }).then(x => x.json());
  check('агент получает одноразовую ссылку для привязки', link.ok && /\/link\/[a-f0-9]{32}$/.test(link.url), link.url);

  const follow = await fetch(link.url, { redirect: 'manual' });
  const loc = follow.headers.get('location') || '';
  check('ссылка ведёт на согласие Kick с PKCE', loc.startsWith('https://id.kick.com/oauth/authorize') && loc.includes('code_challenge='),
    loc.slice(0, 60));
  check('ссылка одноразовая', (await fetch(link.url)).status === 400);

  /* --- offline agent --- */
  a.close();
  await sleep(400);
  r = await signedPost(chat(A.bid, '!join'));
  check('событие при офлайн-агенте подтверждается', r.status === 200 && r.text === 'offline', `${r.status} ${r.text}`);

  /* --- reconnect keeps identity --- */
  const a2 = agentConnect(A);
  await a2.ready;
  await sleep(300);
  check('агент переподключается с тем же ключом', a2.got[0] && a2.got[0].agent.id === A.id);
  a2.close();

  const st = await fetch(BASE + '/status').then(x => x.json());
  check('статус релея показывает агентов', st.ok && st.agents.length === 2, JSON.stringify(st.agents && st.agents.map(x => x.channel)));
} catch (e) {
  fail++;
  console.log(' FAIL  исключение:', e.message);
}

await sleep(200);
cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
