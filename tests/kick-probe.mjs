/* Diagnostic probe for the Kick public API, run against the stored OAuth token.
   Prints status and a trimmed body for each endpoint the webhook adapter depends on,
   so a failing connect can be diagnosed without re-authorizing.

   Usage: node tests/kick-probe.mjs */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.kick.com/public/v1';

let tokens, cfg;
try { tokens = JSON.parse(readFileSync(resolve(ROOT, '.tokens.json'), 'utf8')).kick; }
catch { tokens = null; }
try { cfg = JSON.parse(readFileSync(resolve(ROOT, 'config.json'), 'utf8')); }
catch { cfg = { kick: {} }; }

if (!tokens || !tokens.accessToken) {
  console.log('Нет сохранённого токена Kick. Откройте http://127.0.0.1:7777/auth/kick и повторите.');
  process.exit(1);
}

console.log('scope в токене:', JSON.stringify(tokens.scope));
console.log('истекает через:', Math.round((tokens.expiresAt - Date.now()) / 60000), 'мин\n');

const trim = s => s.replace(/\s+/g, ' ').slice(0, 300);

async function probe(label, path, init = {}, auth = true) {
  const headers = { accept: 'application/json', ...(init.headers || {}) };
  if (auth) headers.authorization = `Bearer ${tokens.accessToken}`;
  if (init.body) headers['content-type'] = 'application/json';
  try {
    const r = await fetch(API + path, { ...init, headers });
    const t = await r.text();
    console.log(`${r.ok ? 'OK ' : '!! '} ${label.padEnd(34)} ${r.status}  ${trim(t)}`);
    return { status: r.status, body: t };
  } catch (e) {
    console.log(`ERR ${label.padEnd(34)} ${e.message}`);
    return { status: 0, body: '' };
  }
}

console.log('--- что работает без токена ---');
await probe('GET /public-key (без auth)', '/public-key', {}, false);

console.log('\n--- что работает с токеном ---');
await probe('GET /public-key (с auth)', '/public-key');
const me = await probe('GET /users', '/users');
await probe('GET /channels', '/channels');
if (cfg.kick.channel) await probe('GET /channels?slug=', `/channels?slug=${encodeURIComponent(cfg.kick.channel)}`);
await probe('GET /events/subscriptions', '/events/subscriptions');

let uid = 0;
try {
  const j = JSON.parse(me.body);
  const u = (j.data || [])[0] || {};
  uid = u.user_id || u.id || 0;
} catch {}
console.log('\nuser id из /users:', uid || 'не определён');

console.log('\n--- варианты тела подписки (ищем тот, который Kick примет) ---');
const base = { events: [{ name: 'chat.message.sent', version: 1 }] };
const variants = [
  ['method:webhook + broadcaster_user_id', { ...base, method: 'webhook', broadcaster_user_id: uid }],
  ['method:webhook без broadcaster', { ...base, method: 'webhook' }],
  ['method:webhook + url в теле', { ...base, method: 'webhook', webhook_url: (cfg.kick.publicUrl || '') + '/webhooks/kick' }],
];
for (const [label, body] of variants) {
  const r = await probe(label, '/events/subscriptions', { method: 'POST', body: JSON.stringify(body) });
  if (r.status >= 200 && r.status < 300) {
    console.log('   ^ этот вариант принят — чистим созданную подписку');
    try {
      const j = JSON.parse(r.body);
      const id = ((j.data || [])[0] || {}).subscription_id;
      if (id) await probe('  DELETE созданной подписки', `/events/subscriptions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {}
    break;
  }
}

console.log('\nГотово. Строки с "!!" показывают, что именно Kick отвергает.');
