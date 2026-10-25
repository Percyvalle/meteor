/* Verifies the Kick webhook receiver without Kick: we generate an RSA keypair,
   sign payloads exactly the way Kick does ("<id>.<timestamp>.<raw body>", RSA-SHA256,
   base64) and push them through KickWebhookAdapter.receive().
   This covers the security-critical path: signature, replay, staleness, parsing. */
import { generateKeyPairSync, createSign } from 'node:crypto';
import { KickWebhookAdapter } from '../server/adapters/kick-webhook.mjs';
import { ChatBus } from '../server/bus.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const cfg = {
  port: 7777,
  limits: { dedupeMs: 2000 },
  kick: { channel: 'teststreamer', clientId: 'x', clientSecret: 'y', transport: 'webhook' },
};

const bus = new ChatBus(cfg);
const seen = [];
bus.on('message', m => seen.push(m));

const a = new KickWebhookAdapter({ cfg, bus });
a.publicKey = publicKey;      // normally fetched from GET /public/v1/public-key

function deliver(body, over = {}) {
  const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const id = over.id ?? 'msg-' + Math.random().toString(36).slice(2);
  const ts = over.ts ?? new Date().toISOString();
  const sig = over.sig ?? createSign('RSA-SHA256')
    .update(Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]))
    .sign(privateKey)
    .toString('base64');
  const headers = {
    'kick-event-message-id': id,
    'kick-event-message-timestamp': ts,
    'kick-event-signature': sig,
    'kick-event-type': over.type ?? 'chat.message.sent',
  };
  for (const k of over.drop || []) delete headers[k];
  return { status: a.receive(headers, raw), id };
}

const chat = (text, sender = {}) => ({
  message_id: 'm1',
  broadcaster: { user_id: 777, slug: 'teststreamer' },
  sender: {
    user_id: sender.user_id ?? 12345,
    username: sender.username ?? 'SomeViewer',
    slug: sender.slug ?? 'someviewer',
    identity: { badges: (sender.badges || []).map(t => ({ type: t })) },
  },
  content: text,
});

/* ---- happy path ---- */
seen.length = 0;
let r = deliver(chat('!join 2'));
check('a correctly signed event is accepted', r.status === 200, `status ${r.status}`);
check('the message reaches the bus', seen.length === 1 && seen[0].text === '!join 2', JSON.stringify(seen[0] || null));
check('identity is namespaced', seen[0] && seen[0].key === 'kick:12345', seen[0] && seen[0].key);

/* ---- roles ---- */
seen.length = 0;
deliver(chat('!meteor go', { user_id: 2, username: 'Mod', badges: ['moderator'] }));
check('moderator badge maps to mod', seen[0] && seen[0].roles.mod === true);
seen.length = 0;
deliver(chat('!meteor start', { user_id: 3, username: 'Owner', badges: ['broadcaster'] }));
check('broadcaster badge maps to broadcaster', seen[0] && seen[0].roles.broadcaster === true);
seen.length = 0;
deliver(chat('hi', { user_id: 4, username: 'Streamer', slug: 'teststreamer' }));
check('channel owner is recognized by slug', seen[0] && seen[0].roles.broadcaster === true);

/* ---- forged signature ---- */
seen.length = 0;
r = deliver(chat('!join'), { sig: Buffer.from('nope').toString('base64') });
check('a forged signature is rejected with 403', r.status === 403, `status ${r.status}`);
check('a forged event never reaches the bus', seen.length === 0);

/* ---- tampered body (signature was made for different bytes) ---- */
seen.length = 0;
const good = chat('!join 1');
const rawGood = Buffer.from(JSON.stringify(good), 'utf8');
const id = 'tamper-1', ts = new Date().toISOString();
const sig = createSign('RSA-SHA256').update(Buffer.concat([Buffer.from(`${id}.${ts}.`), rawGood])).sign(privateKey).toString('base64');
const tampered = Buffer.from(JSON.stringify(chat('!meteor reset')), 'utf8');
const st = a.receive({
  'kick-event-message-id': id, 'kick-event-message-timestamp': ts,
  'kick-event-signature': sig, 'kick-event-type': 'chat.message.sent',
}, tampered);
check('a tampered body is rejected', st === 403 && seen.length === 0, `status ${st}`);

/* ---- replay ---- */
seen.length = 0;
const first = deliver(chat('!join 3'), { id: 'replay-me' });
const second = deliver(chat('!join 3'), { id: 'replay-me' });
check('a replayed message id is answered 200 but ignored', first.status === 200 && second.status === 200 && seen.length === 1,
  `delivered ${seen.length}`);

/* ---- stale timestamp ---- */
seen.length = 0;
r = deliver(chat('!join'), { ts: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
check('a stale timestamp is rejected', r.status === 400 && seen.length === 0, `status ${r.status}`);

/* ---- malformed input ---- */
check('missing headers are rejected', a.receive({}, Buffer.from('{}')) === 400);
seen.length = 0;
r = deliver('{not json');
check('a signed but unparseable body is rejected', r.status === 400 && seen.length === 0, `status ${r.status}`);

/* ---- other event types pass through without producing chat ---- */
seen.length = 0;
r = deliver({ some: 'other event' }, { type: 'channel.followed' });
check('unrelated event types are acknowledged and ignored', r.status === 200 && seen.length === 0);

/* ---- no public key yet: tell Kick to retry rather than drop the event ---- */
const cold = new KickWebhookAdapter({ cfg, bus });
check('without a public key we answer 503 so Kick retries', cold.receive({
  'kick-event-message-id': 'x', 'kick-event-message-timestamp': new Date().toISOString(), 'kick-event-signature': 'x',
}, Buffer.from('{}')) === 503);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
