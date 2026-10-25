/* The whole chain, exactly as a streamer would run it:

   signed Kick webhook -> relay -> agent SSE -> local host bus -> router -> lobby

   Starts its own relay and its own host on spare ports, with its own config and
   state files, and puts everything back afterwards. */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, createSign, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_PORT = 8097, HOST_PORT = 7797;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const HOST = `http://127.0.0.1:${HOST_PORT}`;
const BID = 987654;

const files = {
  state: resolve(ROOT, '.relay-state.json'),
  agent: resolve(ROOT, '.agent.json'),
  config: resolve(ROOT, 'config.json'),
};
const saved = {};
for (const [k, f] of Object.entries(files)) if (existsSync(f)) saved[k] = readFileSync(f);

let pass = 0, fail = 0;
const check = (n, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${n}${extra ? ' — ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = k => createHash('sha256').update(k).digest('hex');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });

const agentId = randomBytes(16).toString('hex');
const agentKey = randomBytes(32).toString('hex');

let relay = null, host = null;

function restore() {
  for (const p of [relay, host]) { try { p && p.kill(); } catch {} }
  for (const [k, f] of Object.entries(files)) {
    try { saved[k] ? writeFileSync(f, saved[k]) : rmSync(f, { force: true }); } catch {}
  }
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

function signedChat(text, sender = {}) {
  const body = {
    message_id: randomBytes(6).toString('hex'),
    broadcaster: { user_id: BID, slug: 'e2e_streamer' },
    sender: {
      user_id: sender.user_id ?? 4242,
      username: sender.username ?? 'ЖивойЗритель',
      slug: 'viewer',
      identity: { badges: (sender.badges || []).map(t => ({ type: t })) },
    },
    content: text,
  };
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const id = 'm-' + randomBytes(6).toString('hex');
  const ts = new Date().toISOString();
  const sig = createSign('RSA-SHA256')
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw])).sign(privateKey).toString('base64');
  return fetch(RELAY + '/webhooks/kick', {
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

try {
  /* The agent identity the host would have generated on first run, pre-linked on
     the relay as if the streamer had already clicked through the Kick consent. */
  writeFileSync(files.agent, JSON.stringify({ id: agentId, key: agentKey, createdAt: Date.now() }));
  writeFileSync(files.state, JSON.stringify({
    agents: {
      [agentId]: {
        id: agentId, keyHash: hash(agentKey), createdAt: Date.now(),
        broadcasterUserId: BID, channel: 'e2e_streamer',
        tokens: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600e3, scope: 'user:read channel:read chat:write events:subscribe' },
      },
    },
    byBroadcaster: { [String(BID)]: agentId },
  }));
  writeFileSync(files.config, JSON.stringify({
    port: HOST_PORT,
    game: { lobbySeconds: 600, winners: 1, autoStart: false, simulateBots: 0 },
    replies: 'off',
    twitch: { enabled: false, channel: '' },
    kick: { enabled: true, transport: 'relay', relayUrl: RELAY },
  }));

  relay = spawn(process.execPath, [resolve(ROOT, 'relay/index.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT), RELAY_PUBLIC_URL: RELAY, KICK_CLIENT_ID: 't', KICK_CLIENT_SECRET: 't', KICK_PUBLIC_KEY_PEM: PEM, LOG_LEVEL: 'warn' },
  });
  relay.stderr.on('data', d => process.stderr.write('[relay] ' + d));

  host = spawn(process.execPath, [resolve(ROOT, 'server/index.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'warn' },
  });
  host.stderr.on('data', d => process.stderr.write('[host] ' + d));

  check('релей поднялся', await waitFor(RELAY + '/status'));
  check('хост поднялся', await waitFor(HOST + '/api/state'));

  /* The host dials the relay by itself; give it a moment to land. */
  let linked = false;
  for (let i = 0; i < 30; i++) {
    const st = await fetch(RELAY + '/status').then(r => r.json()).catch(() => null);
    if (st && st.online > 0) { linked = true; break; }
    await sleep(300);
  }
  check('локальный хост сам дозвонился до релея', linked);

  const k = await fetch(HOST + '/api/state').then(r => r.json()).then(j => j.adapters.kick);
  check('хост видит себя подключённым через релей', k.status === 'connected' && k.transport === 'relay', `${k.status} ${k.detail}`);
  check('канал приехал с релея без настройки на хосте', k.channel === 'e2e_streamer', k.channel);

  /* Open a lobby, then speak as a Kick viewer. */
  await fetch(HOST + '/api/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'start' }) });
  await sleep(600);

  let r = await signedChat('!join 2');
  check('вебхук принят релеем', r.status === 200 && r.text === 'ok', `${r.status} ${r.text}`);

  let session = null;
  for (let i = 0; i < 20; i++) {
    session = await fetch(HOST + '/api/state').then(x => x.json()).then(j => j.session);
    if (session.players > 0) break;
    await sleep(300);
  }
  check('зритель с Kick попал в лобби', session && session.players === 1, `players=${session && session.players}`);

  const roster = await fetch(HOST + '/events?role=overlay')
    .then(x => x.body.getReader().read())
    .then(({ value }) => {
      const line = new TextDecoder().decode(value).split('\n').find(l => l.startsWith('data: '));
      return JSON.parse(line.slice(6)).session.roster;
    });
  check('личность игрока namespace-нута платформой', roster[0] && roster[0].key === 'kick:4242', roster[0] && roster[0].key);
  check('ник и выбранный остров доехали', roster[0] && roster[0].display === 'ЖивойЗритель' && roster[0].choice === 2,
    JSON.stringify(roster[0]));

  /* Moderator command travels the same path. */
  r = await signedChat('!meteor winners 3', { user_id: 77, username: 'Модер', badges: ['moderator'] });
  await sleep(800);
  session = await fetch(HOST + '/api/state').then(x => x.json()).then(j => j.session);
  check('команда модератора из Kick применилась', session.winners === 3, `winners=${session.winners}`);

  /* A viewer must not be able to run admin commands, even over the relay. */
  r = await signedChat('!meteor reset', { user_id: 4242, username: 'ЖивойЗритель' });
  await sleep(800);
  session = await fetch(HOST + '/api/state').then(x => x.json()).then(j => j.session);
  check('обычный зритель не может сбросить игру', session.phase === 'lobby', session.phase);
} catch (e) {
  fail++;
  console.log(' FAIL  исключение:', e.message);
}

await sleep(200);
restore();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
