/* Browser OAuth flows, both landing back on the loopback redirect.
   Twitch: authorization code. Kick: authorization code + PKCE (required by OAuth 2.1).
   Secrets stay here; the browser only ever sees the authorize URL. */
import { randomBytes, createHash } from 'node:crypto';
import { setTokens } from './store.mjs';
import { logger } from '../log.mjs';

const log = logger('oauth');

const TWITCH = {
  authorize: 'https://id.twitch.tv/oauth2/authorize',
  token: 'https://id.twitch.tv/oauth2/token',
  scopes: ['user:read:chat', 'user:write:chat', 'user:bot'],
};

const KICK = {
  authorize: 'https://id.kick.com/oauth/authorize',
  token: 'https://id.kick.com/oauth/token',
  scopes: ['user:read', 'channel:read', 'chat:write', 'events:subscribe'],
};

/* Pending flows, keyed by the state we sent out. */
const pending = new Map();

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function redirectUri(cfg, platform) {
  return `http://localhost:${cfg.port}/auth/${platform}/callback`;
}

export function authorizeUrl(cfg, platform) {
  const state = base64url(randomBytes(16));
  const entry = { platform, at: Date.now() };

  let url;
  if (platform === 'twitch') {
    if (!cfg.twitch.clientId || !cfg.twitch.clientSecret) throw new Error('twitch.clientId / twitch.clientSecret are not set in config.json');
    const q = new URLSearchParams({
      client_id: cfg.twitch.clientId,
      redirect_uri: redirectUri(cfg, 'twitch'),
      response_type: 'code',
      scope: TWITCH.scopes.join(' '),
      state,
      force_verify: 'true',
    });
    url = `${TWITCH.authorize}?${q}`;
  } else {
    if (!cfg.kick.clientId || !cfg.kick.clientSecret) throw new Error('kick.clientId / kick.clientSecret are not set in config.json');
    const verifier = base64url(randomBytes(48));
    entry.verifier = verifier;
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const q = new URLSearchParams({
      client_id: cfg.kick.clientId,
      redirect_uri: redirectUri(cfg, 'kick'),
      response_type: 'code',
      scope: KICK.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    url = `${KICK.authorize}?${q}`;
  }

  pending.set(state, entry);
  // Abandoned flows must not pile up.
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
  return url;
}

export async function handleCallback(cfg, platform, query) {
  if (query.get('error')) throw new Error(`${platform} denied: ${query.get('error_description') || query.get('error')}`);
  const code = query.get('code');
  const state = query.get('state');
  if (!code || !state) throw new Error('callback is missing code or state');
  const entry = pending.get(state);
  if (!entry || entry.platform !== platform) throw new Error('unknown or expired state - start again at /auth/' + platform);
  pending.delete(state);

  if (platform === 'twitch') {
    const body = new URLSearchParams({
      client_id: cfg.twitch.clientId,
      client_secret: cfg.twitch.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(cfg, 'twitch'),
    });
    const r = await fetch(TWITCH.token, { method: 'POST', body });
    if (!r.ok) throw new Error(`twitch token exchange -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();

    // Identify the authorized account so the adapter can send as it.
    const who = await fetch('https://api.twitch.tv/helix/users', {
      headers: { authorization: `Bearer ${j.access_token}`, 'client-id': cfg.twitch.clientId },
    }).then(x => x.json()).catch(() => null);
    const me = who && who.data && who.data[0];

    setTokens('twitch', {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope || TWITCH.scopes,
      login: me ? me.login : '',
      userId: me ? me.id : '',
    });
    log.info(`twitch authorized as ${me ? me.login : 'unknown'}`);
    return me ? me.login : 'twitch';
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.kick.clientId,
    client_secret: cfg.kick.clientSecret,
    redirect_uri: redirectUri(cfg, 'kick'),
    code_verifier: entry.verifier,
    code,
  });
  const r = await fetch(KICK.token, { method: 'POST', body });
  if (!r.ok) throw new Error(`kick token exchange -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  setTokens('kick', {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
    scope: j.scope || KICK.scopes,
  });
  log.info('kick authorized');
  return 'kick';
}
