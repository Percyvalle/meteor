/* Claiming a channel by slug — the path for a streamer who has no access to the
   account of the channel they stream on.

   Verified live against Kick first (an app access token may subscribe to
   chat.message.sent for any broadcaster_user_id); this test pins the relay's half
   of it against a stand-in Kick, so the suite stays offline. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097;
const KICK_PORT = 8096;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE = resolve(ROOT, '.relay-state.json');
const BACKUP = STATE + '.claimbak';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

/* The streamer's host: a fresh agent with nothing bound to it. */
const A = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex') };
/* The channel they stream on but have no access to, and the one they move to. */
const CH = { slug: 'someone_elses_channel', bid: 93620609 };
const CH2 = { slug: 'another_channel', bid: 55500123 };

if (existsSync(STATE)) writeFileSync(BACKUP, readFileSync(STATE));
const hash = k => createHash('sha256').update(k).digest('hex');
writeFileSync(STATE, JSON.stringify({
  agents: { [A.id]: { id: A.id, keyHash: hash(A.key), createdAt: Date.now(), broadcasterUserId: 0, channel: '' } },
  byBroadcaster: {},
}, null, 2));

/* ---- stand-in Kick ---- */
const seen = { tokenGrants: [], subscribed: [], deleted: [] };
let subSeq = 0;

const kick = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const reply = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const auth = String(req.headers.authorization || '');

  if (req.method === 'POST' && url.pathname === '/oauth/token') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const p = new URLSearchParams(body);
      seen.tokenGrants.push(p.get('grant_type'));
      if (p.get('grant_type') !== 'client_credentials') return reply(400, { error: 'unsupported' });
      reply(200, { access_token: 'app-token', token_type: 'Bearer', expires_in: 5184000 });
    });
    return;
  }

  // Everything below must carry the app token, never a streamer's.
  if (auth !== 'Bearer app-token') return reply(401, { message: 'Unauthorized' });

  if (req.method === 'GET' && url.pathname === '/channels') {
    const slug = url.searchParams.get('slug');
    const hit = [CH, CH2].find(c => c.slug === slug);
    if (!hit) return reply(200, { data: [] });
    return reply(200, { data: [{ slug: hit.slug, broadcaster_user_id: hit.bid }] });
  }

  if (url.pathname === '/events/subscriptions') {
    if (req.method === 'GET') return reply(200, { data: [] });
    if (req.method === 'DELETE') { seen.deleted.push(url.searchParams.get('id')); return reply(204, {}); }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch {}
        seen.subscribed.push(j);
        reply(200, { data: [{ subscription_id: 'sub-' + (++subSeq), name: 'chat.message.sent', version: 1 }], message: 'OK' });
      });
      return;
    }
  }

  reply(404, { message: 'Not found' });
});
await new Promise(r => kick.listen(KICK_PORT, '127.0.0.1', r));

const relay = spawn(process.execPath, [resolve(ROOT, 'relay/index.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    RELAY_PORT: String(PORT), RELAY_PUBLIC_URL: BASE,
    KICK_CLIENT_ID: 'test', KICK_CLIENT_SECRET: 'test',
    KICK_PUBLIC_KEY_PEM: PEM,
    KICK_API_BASE: `http://127.0.0.1:${KICK_PORT}`,
    KICK_TOKEN_URL: `http://127.0.0.1:${KICK_PORT}/oauth/token`,
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stdout.on('data', () => {});
relay.stderr.on('data', d => process.stderr.write(d));

function cleanup() {
  try { relay.kill(); } catch {}
  try { kick.close(); } catch {}
  try {
    if (existsSync(BACKUP)) { writeFileSync(STATE, readFileSync(BACKUP)); rmSync(BACKUP); }
    else rmSync(STATE, { force: true });
  } catch {}
}

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/status'); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

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
  })();
  return { got, ready, close: () => ctrl.abort() };
}

const post = (path, body) => fetch(`${BASE}${path}?agent=${A.id}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${A.key}`, 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => ({})) }));

function signedPost(body) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const id = 'm-' + randomBytes(6).toString('hex');
  const ts = new Date().toISOString();
  const sig = createSign('RSA-SHA256')
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw])).sign(privateKey).toString('base64');
  return fetch(BASE + '/webhooks/kick', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'kick-event-message-id': id,
      'kick-event-message-timestamp': ts,
      'kick-event-signature': sig,
      'kick-event-type': 'chat.message.sent',
    },
    body: raw,
  }).then(async r => ({ status: r.status, text: await r.text() }));
}

const chatOf = (text, ch = CH) => ({
  message_id: randomBytes(6).toString('hex'),
  broadcaster: { user_id: ch.bid, slug: ch.slug },
  sender: { user_id: 777, username: 'Viewer', slug: 'viewer', identity: { badges: [] } },
  content: text,
});

/* ---------------- run ---------------- */

try {
  if (!await waitUp()) { console.log('релей не поднялся'); cleanup(); process.exit(1); }

  const a = agentConnect(A);
  await a.ready;
  await sleep(300);
  check('агент стартует без привязки', a.got[0] && a.got[0].agent.linked === false,
    JSON.stringify(a.got[0] || null));

  /* --- the claim itself --- */
  const bogus = await post('/agent/claim', { slug: 'no_such_channel_here' });
  check('несуществующий канал -> 400', bogus.status === 400, `${bogus.status} ${JSON.stringify(bogus.json)}`);

  const junk = await post('/agent/claim', { slug: 'не слаг!!' });
  check('мусор вместо слага отвергается', junk.status === 400, String(junk.status));

  const claim = await post('/agent/claim', { slug: CH.slug });
  check('канал привязывается по слагу', claim.status === 200 && claim.json.ok === true,
    `${claim.status} ${JSON.stringify(claim.json)}`);
  check('привязка в режиме app', claim.json.agent && claim.json.agent.mode === 'app', JSON.stringify(claim.json.agent));
  check('привязка считается активной', claim.json.agent && claim.json.agent.linked === true);
  check('и помечена как только чтение', claim.json.agent && claim.json.agent.writable === false);
  check('канал запомнен', claim.json.agent && claim.json.agent.channel === CH.slug);

  check('использован app-токен, не пользовательский',
    seen.tokenGrants.length > 0 && seen.tokenGrants.every(g => g === 'client_credentials'),
    seen.tokenGrants.join(','));
  check('подписка оформлена на чужой broadcaster_user_id',
    seen.subscribed.length === 1 && Number(seen.subscribed[0].broadcaster_user_id) === CH.bid,
    JSON.stringify(seen.subscribed));
  check('подписка именно на chat.message.sent',
    !!seen.subscribed[0] && seen.subscribed[0].events[0].name === 'chat.message.sent');

  /* --- claim is pushed to the host over the live stream --- */
  await sleep(200);
  const pushed = a.got.filter(m => m.t === 'status').pop();
  check('хост узнаёт о привязке по своему потоку',
    pushed && pushed.agent.linked === true && pushed.agent.mode === 'app', JSON.stringify(pushed || null));

  /* --- routing works the same as for an OAuth binding --- */
  a.got.length = 0;
  const ev = await signedPost(chatOf('!join 2'));
  await sleep(250);
  check('событие захваченного канала доставлено',
    ev.status === 200 && a.got.length === 1 && a.got[0].msg.text === '!join 2',
    `${ev.status} ${ev.text} ${JSON.stringify(a.got)}`);

  /* --- writing stays closed: there is no owner token --- */
  const say = await post('/agent/say', { text: 'победил кто-то' });
  check('отправка в чат отклоняется 409', say.status === 409, `${say.status} ${JSON.stringify(say.json)}`);
  check('и объясняет, почему', /только читать/.test(say.json.error || ''), say.json.error);

  /* --- moving to another channel: no server-side editing, just a new claim --- */
  const moved = await post('/agent/claim', { slug: CH2.slug });
  check('переезд на другой канал проходит', moved.status === 200 && moved.json.agent.channel === CH2.slug,
    `${moved.status} ${JSON.stringify(moved.json)}`);
  check('подписка прежнего канала снята при переезде', seen.deleted.includes('sub-1'), JSON.stringify(seen.deleted));

  a.got.length = 0;
  const evNew = await signedPost(chatOf('!join', CH2));
  await sleep(250);
  const chats = a.got.filter(m => m.t === 'chat');
  check('чат нового канала доезжает', evNew.status === 200 && chats.length === 1 && chats[0].msg.text === '!join',
    JSON.stringify(a.got));

  a.got.length = 0;
  const evOld = await signedPost(chatOf('!join', CH));
  await sleep(250);
  check('старый канал отцеплен',
    evOld.text === 'unlinked' && a.got.filter(m => m.t === 'chat').length === 0,
    `${evOld.text} ${JSON.stringify(a.got)}`);

  // Вернуться к первому каналу, чтобы остальные проверки шли по нему.
  await post('/agent/claim', { slug: CH.slug });
  await sleep(200);

  /* --- unlink releases the subscription with the app token --- */
  const un = await post('/agent/unlink', {});
  await sleep(250);
  check('отвязка проходит', un.status === 200, String(un.status));
  check('подписка снята app-токеном', seen.deleted.length > 0, JSON.stringify(seen.deleted));

  const after = await signedPost(chatOf('!join'));
  check('после отвязки канал больше не маршрутизируется', after.text === 'unlinked', after.text);

  a.close();
} catch (e) {
  fail++;
  console.log(' FAIL  исключение:', e.message);
}

await sleep(200);
cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
