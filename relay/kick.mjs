/* Everything that talks to Kick, on behalf of many streamers.

   Lifted from the single-tenant webhook adapter after it was verified against the
   live API, with the one change the relay needs: every call takes the streamer's
   own tokens instead of reading one global token file. */
import { createVerify, createPublicKey, randomBytes, createHash } from 'node:crypto';
import { logger } from '../server/log.mjs';
import { setTokens } from './store.mjs';

const log = logger('kick');

const API = 'https://api.kick.com/public/v1';
const AUTHORIZE = 'https://id.kick.com/oauth/authorize';
const TOKEN_URL = 'https://id.kick.com/oauth/token';

/* Verified live: the app's scopes must grant all of these or /events/subscriptions
   answers a bare 401 with no hint about what is missing. */
export const SCOPES = ['user:read', 'channel:read', 'chat:write', 'events:subscribe'];

let publicKeyCache = null;

/* The endpoint is public and REJECTS a bearer token with 401 — verified live.
   Never send credentials here. */
export async function kickPublicKey() {
  if (publicKeyCache) return publicKeyCache;
  // Pinning hook: supply the PEM yourself to avoid the network round trip, to pin
  // a known-good key, or to drive the relay in tests.
  if (process.env.KICK_PUBLIC_KEY_PEM) {
    publicKeyCache = createPublicKey(process.env.KICK_PUBLIC_KEY_PEM);
    return publicKeyCache;
  }
  const r = await fetch(`${API}/public-key`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`public-key -> ${r.status}`);
  const j = await r.json();
  const pem = (j.data && j.data.public_key) || j.public_key;
  if (!pem) throw new Error('public-key response had no key');
  publicKeyCache = createPublicKey(pem);
  return publicKeyCache;
}

/* Kick signs "<message id>.<timestamp>.<raw body>" with RSA-SHA256, base64. */
export function verifySignature(publicKey, headers, raw) {
  const id = headers['kick-event-message-id'];
  const ts = headers['kick-event-message-timestamp'];
  const sig = headers['kick-event-signature'];
  if (!id || !ts || !sig) return { ok: false, reason: 'missing headers' };

  const payload = Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]);
  let ok = false;
  try {
    ok = createVerify('RSA-SHA256').update(payload).verify(publicKey, Buffer.from(sig, 'base64'));
  } catch { ok = false; }
  if (!ok) return { ok: false, reason: 'bad signature' };

  const age = Math.abs(Date.now() - Date.parse(ts));
  if (Number.isFinite(age) && age > 5 * 60 * 1000) return { ok: false, reason: 'stale timestamp' };
  return { ok: true, id, ts };
}

/* ---------- OAuth (2.1 + PKCE) ---------- */

const base64url = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function beginAuth(cfg, state) {
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { url: `${AUTHORIZE}?${q}`, verifier };
}

export async function exchangeCode(cfg, code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    code,
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', body });
  const text = await r.text();
  if (!r.ok) throw new Error(`token exchange -> ${r.status} ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope,
  };
}

async function refresh(cfg, agent) {
  const t = agent.tokens;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', body });
  if (!r.ok) throw new Error(`refresh -> ${r.status}`);
  const j = await r.json();
  const next = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || t.refreshToken,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || t.scope,
  };
  agent.tokens = next;
  setTokens(agent.id, next);
  log.info(`${agent.channel || agent.id}: token refreshed`);
  return next.accessToken;
}

async function tokenFor(cfg, agent) {
  const t = agent.tokens;
  if (!t) throw new Error('not linked');
  if (t.expiresAt && t.expiresAt - Date.now() > 60000) return t.accessToken;
  if (!t.refreshToken) return t.accessToken;
  return refresh(cfg, agent);
}

export function missingScopes(tokens) {
  const raw = tokens && tokens.scope;
  const have = new Set(Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/).filter(Boolean));
  return SCOPES.filter(s => !have.has(s));
}

/* ---------- authenticated API ---------- */

export async function api(cfg, agent, path, init = {}) {
  const token = await tokenFor(cfg, agent);
  const r = await fetch(API + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${path} -> ${r.status} ${text.slice(0, 300)}`), { status: r.status });
  return text ? JSON.parse(text) : null;
}

export async function whoAmI(cfg, agent) {
  const j = await api(cfg, agent, '/users');
  const u = (j.data || [])[0] || {};
  return { userId: u.user_id || u.id || 0, name: u.name || '' };
}

export async function channelOf(cfg, agent) {
  const j = await api(cfg, agent, '/channels');
  const c = (j.data || [])[0] || {};
  return { slug: c.slug || '', broadcasterUserId: c.broadcaster_user_id || 0 };
}

/* Verified live: Kick takes the webhook URL from the app settings, NOT from this
   body. Sending it here is neither required nor accepted. */
export async function subscribeChat(cfg, agent, broadcasterUserId) {
  try {
    const existing = await api(cfg, agent, '/events/subscriptions');
    for (const s of (existing.data || [])) {
      if (s.event === 'chat.message.sent' && Number(s.broadcaster_user_id) === Number(broadcasterUserId)) {
        await api(cfg, agent, `/events/subscriptions?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      }
    }
  } catch (e) {
    log.warn(`${agent.channel || agent.id}: could not clean old subscriptions: ${e.message}`);
  }

  const created = await api(cfg, agent, '/events/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      method: 'webhook',
      broadcaster_user_id: Number(broadcasterUserId),
      events: [{ name: 'chat.message.sent', version: 1 }],
    }),
  });
  const row = (created && (created.data || [])[0]) || {};
  if (row.error) throw new Error(`subscription refused: ${row.error}`);
  return row.subscription_id || row.id || null;
}

export async function unsubscribe(cfg, agent, subscriptionId) {
  if (!subscriptionId) return;
  try { await api(cfg, agent, `/events/subscriptions?id=${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' }); }
  catch (e) { log.warn(`unsubscribe failed: ${e.message}`); }
}

export async function sendChat(cfg, agent, text, type = 'bot') {
  return api(cfg, agent, '/chat', {
    method: 'POST',
    body: JSON.stringify({ broadcaster_user_id: agent.broadcasterUserId, content: text, type }),
  });
}

/* ---------- event shaping ---------- */

/* Turns a raw chat.message.sent into the normalized form the game's bus expects.
   Kept here so the agent receives something it can hand straight to the bus. */
export function normalizeChat(e, channelSlug) {
  const sender = e.sender || {};
  const badges = ((sender.identity || {}).badges || []).map(b => b.type || b);
  const slug = String(sender.channel_slug || sender.slug || '').toLowerCase();
  return {
    platform: 'kick',
    userId: sender.user_id ?? sender.id,
    display: sender.username || sender.slug,
    text: e.content || '',
    roles: {
      broadcaster: badges.includes('broadcaster') || (!!channelSlug && slug === String(channelSlug).toLowerCase()),
      mod: badges.includes('moderator'),
      vip: badges.includes('vip') || badges.includes('og'),
      sub: badges.includes('subscriber') || badges.includes('founder'),
    },
  };
}

export function broadcasterOf(e) {
  const b = e.broadcaster || {};
  return b.user_id ?? b.id ?? e.broadcaster_user_id ?? 0;
}
