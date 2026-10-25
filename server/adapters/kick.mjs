/* Kick adapter.
   Read path, transport "ws": Kick's public Pusher socket. This is UNOFFICIAL —
   the app key, the channel naming and the slug lookup are not covered by any
   documented contract and can change without notice. It is the only way to read
   Kick chat from a purely local host, because the official API delivers chat
   through webhooks, which need a publicly reachable URL.
   Read path, transport "webhook": not implemented yet (see README, stage 5).
   Write path: official POST /public/v1/chat with an OAuth token — no tunnel needed. */
import { Adapter } from './base.mjs';
import { getTokens, setTokens, clearTokens } from '../oauth/store.mjs';

const API = 'https://api.kick.com/public/v1';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

export class KickAdapter extends Adapter {
  constructor(opts) {
    super('kick', opts);
    this.channel = String(this.cfg.kick.channel || '').toLowerCase();
    this.chatroomId = this.cfg.kick.chatroomId || 0;
    this.pusherKey = this.cfg.kick.pusherKey || '';
    this.pusherCluster = this.cfg.kick.pusherCluster || 'us2';
    this.broadcasterUserId = 0;
    this.ws = null;
    this.pingTimer = null;
  }

  /* ---------- auth (only needed to send messages) ---------- */

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
    // One 401 is not proof the session is dead; only a failed refresh clears tokens.
    if (r.status === 401) throw Object.assign(new Error('kick rejected the token - check scopes, or re-authorize at /auth/kick'), { status: 401 });
    if (!r.ok) throw new Error(`kick ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  /* ---------- channel lookup ---------- */

  /* Two routes, because each fails in its own way:
     - the official API needs an OAuth token but is stable;
     - the public v2 endpoint needs nothing but sits behind Cloudflare and may 403.
     Either way, config.kick.chatroomId lets the streamer pin the value by hand. */
  async resolveChannel() {
    if (this.chatroomId && this.broadcasterUserId) return;

    if (getTokens('kick')) {
      try {
        const j = await this.api(`/channels?slug=${encodeURIComponent(this.channel)}`);
        const c = (j.data || [])[0];
        if (c) {
          this.broadcasterUserId = c.broadcaster_user_id || this.broadcasterUserId;
          this.chatroomId = this.chatroomId || (c.chatroom && c.chatroom.id) || 0;
        }
      } catch (e) {
        this.log.warn(`official channel lookup failed: ${e.message}`);
      }
    }

    if (!this.chatroomId) {
      const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(this.channel)}`, {
        headers: { 'user-agent': UA, accept: 'application/json' },
      });
      if (r.status === 403) {
        // Cloudflare fronts this endpoint; no amount of retrying gets past it.
        this.fatal('Cloudflare blocked the channel lookup - set kick.chatroomId in config.json (README: "Kick за минуту")');
        throw new Error('channel lookup blocked');
      }
      if (!r.ok) throw new Error(`channel lookup -> ${r.status}`);
      const j = await r.json();
      this.chatroomId = (j.chatroom && j.chatroom.id) || 0;
      this.broadcasterUserId = this.broadcasterUserId || j.user_id || 0;
    }

    if (!this.chatroomId) throw new Error('could not determine chatroom id');
  }

  /* ---------- connect ---------- */

  async connect() {
    if (this.stopped || !this.channel) return;
    if (this.cfg.kick.transport === 'webhook') {
      this.setStatus('error', 'webhook transport is not implemented yet - use transport "ws"');
      return;
    }
    if (!this.pusherKey) {
      this.fatal('kick.pusherKey is not set - read the current key from kick.com (README: "Kick за минуту")');
      return;
    }
    this.setStatus('connecting');
    await this.resolveChannel();

    const url = `wss://ws-${this.pusherCluster}.pusher.com/app/${this.pusherKey}?protocol=7&client=js&version=8.4.0&flash=false`;
    const ws = this.ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${this.chatroomId}.v2` } }));
      this.pingTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
      }, 30000);
    });

    ws.addEventListener('message', ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }

      if (m.event === 'pusher:connection_established') return;

      if (m.event === 'pusher_internal:subscription_succeeded') {
        this.attempt = 0;
        this.writable = !!getTokens('kick') && !!this.broadcasterUserId;
        this.setStatus('connected', `ws - ${this.channel} (chatroom ${this.chatroomId})${this.writable ? '' : ' (read-only)'}`);
        return;
      }

      if (m.event === 'pusher:error') {
        const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
        // 4000-4099 are "fix your config and come back" errors in the Pusher protocol.
        if (d.code >= 4000 && d.code < 4100) {
          this.fatal(`pusher ${d.code}: ${d.message} - kick.pusherKey/pusherCluster are stale (README)`);
        } else {
          this.setStatus('error', `pusher ${d.code}: ${d.message}`);
        }
        return;
      }

      if (!String(m.event).endsWith('ChatMessageEvent')) return;

      let d;
      try { d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data; } catch { return; }
      const sender = d.sender || {};
      const badges = ((sender.identity || {}).badges || []).map(b => b.type);
      this.emit({
        userId: sender.id,
        display: sender.username || sender.slug,
        text: d.content || '',
        roles: {
          broadcaster: badges.includes('broadcaster') || String(sender.slug || '').toLowerCase() === this.channel,
          mod: badges.includes('moderator'),
          vip: badges.includes('vip') || badges.includes('og'),
          sub: badges.includes('subscriber') || badges.includes('founder'),
        },
      });
    });

    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      if (!this.stopped) this.scheduleReconnect('socket closed');
    });
    ws.addEventListener('error', () => { /* a close event always follows */ });
  }

  async say(text) {
    if (!this.writable) return;
    await this.api('/chat', {
      method: 'POST',
      body: JSON.stringify({ broadcaster_user_id: this.broadcasterUserId, content: text, type: 'bot' }),
    });
  }

  stop() {
    super.stop();
    clearInterval(this.pingTimer);
    try { if (this.ws) this.ws.close(); } catch {}
  }
}
