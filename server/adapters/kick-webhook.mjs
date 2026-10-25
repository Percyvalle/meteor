/* Kick webhook transport — the official route.

   Kick pushes chat events to a public HTTPS URL instead of offering a socket, so
   this needs a tunnel in front of the local host. In exchange nothing here depends
   on undocumented credentials: events are authenticated with Kick's own signature.

   Flow: OAuth (PKCE) -> POST /public/v1/events/subscriptions -> Kick POSTs
   chat.message.sent to <public url>/webhooks/kick -> verify -> bus. */
import { createVerify, createPublicKey } from 'node:crypto';
import { Adapter } from './base.mjs';
import { getTokens, setTokens, clearTokens } from '../oauth/store.mjs';

const API = 'https://api.kick.com/public/v1';
const TOKEN_URL = 'https://id.kick.com/oauth/token';

export class KickWebhookAdapter extends Adapter {
  constructor(opts) {
    super('kick', opts);
    this.channel = String(this.cfg.kick.channel || '').toLowerCase();
    this.broadcasterUserId = 0;
    this.publicKey = null;
    this.subscriptionId = null;
    this.seenMessages = new Map();   // message id -> time, for replay rejection
    this.lastEventAt = 0;
  }

  /* ---------- auth ---------- */

  async token() {
    const t = getTokens('kick');
    if (!t) return null;
    if (t.expiresAt && t.expiresAt - Date.now() > 60000) return t.accessToken;
    if (!t.refreshToken) return t.accessToken || null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: this.cfg.kick.clientId,
      client_secret: this.cfg.kick.clientSecret,
    });
    const r = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!r.ok) {
      this.log.warn(`token refresh failed (${r.status}) - re-authorize at /auth/kick`);
      clearTokens('kick');
      return null;
    }
    const j = await r.json();
    setTokens('kick', {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || t.refreshToken,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope,
    });
    return j.access_token;
  }

  async api(path, init = {}) {
    const token = await this.token();
    if (!token) throw new Error('not authorized');
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
    // A 401 from one endpoint is not proof the session is dead - it may be a scope
    // or a path problem. Never throw the tokens away here; only a failed refresh does.
    if (!r.ok) {
      const err = new Error(`kick ${path} -> ${r.status} ${text.slice(0, 400)}`);
      err.status = r.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  /* Kick's public key is not user data; try it unauthenticated first, since an
     endpoint that needs no token should not fail because of a token. */
  async fetchPublicKey() {
    try {
      const r = await fetch(`${API}/public-key`, { headers: { accept: 'application/json' } });
      if (r.ok) {
        const j = JSON.parse(await r.text());
        const pem = (j.data && j.data.public_key) || j.public_key;
        if (pem) return pem;
      }
      this.log.debug(`public-key without auth -> ${r.status}`);
    } catch (e) {
      this.log.debug(`public-key without auth failed: ${e.message}`);
    }
    const j = await this.api('/public-key');
    return (j && ((j.data && j.data.public_key) || j.public_key)) || null;
  }

  /* Scopes this transport cannot work without, and what each one is for. */
  static REQUIRED = {
    'user:read': 'определить ваш user id',
    'events:subscribe': 'подписаться на сообщения чата',
    'chat:write': 'писать в чат от имени бота',
  };

  grantedScopes() {
    const raw = (getTokens('kick') || {}).scope;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/).filter(Boolean);
  }

  missingScopes() {
    const have = new Set(this.grantedScopes());
    return Object.keys(KickWebhookAdapter.REQUIRED).filter(s => !have.has(s));
  }

  /* ---------- connect ---------- */

  async connect() {
    if (this.stopped || !this.channel) return;

    if (!this.cfg.kick.clientId || !this.cfg.kick.clientSecret) {
      this.fatal('kick.clientId / kick.clientSecret are not set in config.json');
      return;
    }
    if (!getTokens('kick')) {
      this.fatal('not authorized yet - open http://localhost:' + this.cfg.port + '/auth/kick');
      return;
    }

    // Kick silently grants only the scopes enabled on the app, so a missing one
    // surfaces later as a bare 401 on an unrelated endpoint. Check up front.
    const missing = this.missingScopes();
    if (missing.length) {
      this.fatal(`в токене нет скоупов: ${missing.join(', ')} — включите их в приложении на kick.com/settings/developer и заново откройте /auth/kick`);
      return;
    }

    this.setStatus('connecting');

    // Kick signs every delivery; without the key we cannot trust a single event.
    const pem = await this.fetchPublicKey();
    if (!pem) throw new Error('could not fetch the Kick public key');
    this.publicKey = createPublicKey(pem);

    const me = await this.api('/users');
    const user = (me.data || [])[0] || {};
    this.broadcasterUserId = user.user_id || user.id || 0;
    if (!this.broadcasterUserId) throw new Error('could not resolve the authorized user id');

    await this.subscribe();

    this.attempt = 0;
    this.writable = true;   // the same token that subscribes can post to chat
    this.setStatus('connected', `webhook - ${this.channel} (user ${this.broadcasterUserId})`);
  }

  /* Idempotent: drops any chat subscription we already own, then creates one. */
  async subscribe() {
    try {
      const existing = await this.api('/events/subscriptions');
      const mine = (existing.data || []).filter(s => s.event === 'chat.message.sent');
      for (const s of mine) {
        await this.api(`/events/subscriptions?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      }
    } catch (e) {
      this.log.warn(`could not list existing subscriptions: ${e.message}`);
    }

    const created = await this.api('/events/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        method: 'webhook',
        broadcaster_user_id: this.broadcasterUserId,
        events: [{ name: 'chat.message.sent', version: 1 }],
      }),
    });
    const row = (created && (created.data || [])[0]) || {};
    this.subscriptionId = row.subscription_id || row.id || null;
    if (row.error) throw new Error(`subscription refused: ${row.error}`);
    this.log.info(`subscribed to chat.message.sent${this.subscriptionId ? ' (' + this.subscriptionId + ')' : ''}`);
  }

  /* ---------- inbound ---------- */

  /* Called by the HTTP server for every POST /webhooks/kick.
     Returns an HTTP status: anything but 200 tells Kick to retry. */
  receive(headers, raw) {
    if (!this.publicKey) return 503;

    const id = headers['kick-event-message-id'];
    const ts = headers['kick-event-message-timestamp'];
    const sig = headers['kick-event-signature'];
    const type = headers['kick-event-type'];
    if (!id || !ts || !sig) return 400;

    // Kick signs "<message id>.<timestamp>.<raw body>" — the body must be the exact
    // bytes received, which is why this takes the raw buffer and not parsed JSON.
    const payload = Buffer.concat([Buffer.from(`${id}.${ts}.`, 'utf8'), raw]);
    let ok = false;
    try {
      ok = createVerify('RSA-SHA256').update(payload).verify(this.publicKey, Buffer.from(sig, 'base64'));
    } catch { ok = false; }
    if (!ok) {
      this.log.warn('rejected a webhook with a bad signature');
      return 403;
    }

    // Replay guard: an attacker cannot forge a signature, but may resend a real one.
    const age = Math.abs(Date.now() - Date.parse(ts));
    if (Number.isFinite(age) && age > 5 * 60 * 1000) return 400;
    if (this.seenMessages.has(id)) return 200;
    this.seenMessages.set(id, Date.now());
    if (this.seenMessages.size > 2000) {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [k, t] of this.seenMessages) if (t < cutoff) this.seenMessages.delete(k);
    }

    this.lastEventAt = Date.now();
    if (type && type !== 'chat.message.sent') return 200;

    let e;
    try { e = JSON.parse(raw.toString('utf8')); } catch { return 400; }

    const sender = e.sender || {};
    const badges = (sender.identity?.badges || []).map(b => b.type || b);
    this.emit({
      userId: sender.user_id ?? sender.id,
      display: sender.username || sender.slug,
      text: e.content || '',
      roles: {
        broadcaster: badges.includes('broadcaster') || String(sender.channel_slug || sender.slug || '').toLowerCase() === this.channel,
        mod: badges.includes('moderator'),
        vip: badges.includes('vip') || badges.includes('og'),
        sub: badges.includes('subscriber') || badges.includes('founder'),
      },
    });
    return 200;
  }

  async say(text) {
    if (!this.writable) return;
    await this.api('/chat', {
      method: 'POST',
      body: JSON.stringify({ broadcaster_user_id: this.broadcasterUserId, content: text, type: 'bot' }),
    });
  }

  info() {
    return {
      ...super.info(),
      transport: 'webhook',
      scopes: this.grantedScopes(),
      missingScopes: this.missingScopes(),
      lastEventAt: this.lastEventAt || null,
      subscriptionId: this.subscriptionId,
    };
  }

  async stop() {
    super.stop();
    // Leave no dangling subscription pointing at a tunnel URL that is about to die.
    if (this.subscriptionId) {
      try { await this.api(`/events/subscriptions?id=${encodeURIComponent(this.subscriptionId)}`, { method: 'DELETE' }); }
      catch {}
    }
  }
}
