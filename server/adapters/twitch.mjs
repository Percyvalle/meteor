/* Twitch adapter.
   Read path: EventSub over WebSocket (channel.chat.message) when a user token is
   available, otherwise anonymous IRC — which reads fine but cannot reply.
   Write path: Helix POST /helix/chat/messages. */
import { Adapter } from './base.mjs';
import { getTokens, setTokens, clearTokens } from '../oauth/store.mjs';

const EVENTSUB_WS = 'wss://eventsub.wss.twitch.tv/ws';
const IRC_WS = 'wss://irc-ws.chat.twitch.tv:443';
const HELIX = 'https://api.twitch.tv/helix';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

export class TwitchAdapter extends Adapter {
  constructor(opts) {
    super('twitch', opts);
    this.channel = String(this.cfg.twitch.channel || '').toLowerCase();
    this.ws = null;
    this.broadcasterId = null;
    this.selfId = null;
    this.mode = null;          // 'eventsub' | 'irc'
    this.keepaliveTimer = null;
  }

  /* ---------- auth ---------- */

  async token() {
    const t = getTokens('twitch');
    if (!t) return null;
    if (t.expiresAt && t.expiresAt - Date.now() > 60000) return t.accessToken;
    if (!t.refreshToken) return t.accessToken || null;
    const { clientId, clientSecret } = this.cfg.twitch;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const r = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!r.ok) {
      this.log.warn(`token refresh failed (${r.status}) - re-authorize at /auth/twitch`);
      clearTokens('twitch');
      return null;
    }
    const j = await r.json();
    setTokens('twitch', {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || t.refreshToken,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope,
      login: t.login,
      userId: t.userId,
    });
    return j.access_token;
  }

  async helix(path, init = {}) {
    const token = await this.token();
    if (!token) throw new Error('not authorized');
    const r = await fetch(HELIX + path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'client-id': this.cfg.twitch.clientId,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    // One 401 is not proof the session is dead; only a failed refresh clears tokens.
    if (r.status === 401) throw Object.assign(new Error('twitch rejected the token - check scopes, or re-authorize at /auth/twitch'), { status: 401 });
    if (!r.ok) throw new Error(`helix ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json();
  }

  /* ---------- connect ---------- */

  async connect() {
    if (this.stopped || !this.channel) return;
    this.setStatus('connecting');
    const want = this.cfg.twitch.transport;
    const haveAuth = !!getTokens('twitch') && !!this.cfg.twitch.clientId;
    const mode = want === 'irc' ? 'irc'
      : want === 'eventsub' ? 'eventsub'
      : (haveAuth ? 'eventsub' : 'irc');

    if (mode === 'eventsub' && !haveAuth) {
      this.setStatus('error', 'EventSub needs authorization - open /auth/twitch');
      return;
    }
    this.mode = mode;
    if (mode === 'eventsub') await this.connectEventSub();
    else this.connectIrc();
  }

  async connectEventSub() {
    const users = await this.helix(`/users?login=${encodeURIComponent(this.channel)}`);
    if (!users.data || !users.data.length) {
      this.setStatus('error', `channel "${this.channel}" not found`);
      return;
    }
    this.broadcasterId = users.data[0].id;
    const me = await this.helix('/users');
    this.selfId = me.data[0].id;

    const ws = this.ws = new WebSocket(EVENTSUB_WS);
    ws.addEventListener('message', async ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const type = m.metadata && m.metadata.message_type;

      if (type === 'session_welcome') {
        const session = m.payload.session;
        this.armKeepalive((session.keepalive_timeout_seconds || 10) * 1000);
        try {
          await this.helix('/eventsub/subscriptions', {
            method: 'POST',
            body: JSON.stringify({
              type: 'channel.chat.message',
              version: '1',
              condition: { broadcaster_user_id: this.broadcasterId, user_id: this.selfId },
              transport: { method: 'websocket', session_id: session.id },
            }),
          });
        } catch (e) {
          this.setStatus('error', `subscribe failed: ${e.message}`);
          ws.close();
          return;
        }
        this.attempt = 0;
        const scopes = (getTokens('twitch') || {}).scope || [];
        this.writable = scopes.includes('user:write:chat');
        this.setStatus('connected', `eventsub - #${this.channel}${this.writable ? '' : ' (read-only)'}`);
        return;
      }

      if (type === 'session_keepalive') { this.armKeepalive(); return; }

      if (type === 'session_reconnect') {
        this.log.info('eventsub asked us to reconnect');
        this.swap(m.payload.session.reconnect_url);
        return;
      }

      if (type === 'notification') {
        if (!m.payload.subscription || m.payload.subscription.type !== 'channel.chat.message') return;
        const e = m.payload.event;
        this.emit({
          userId: e.chatter_user_id,
          display: e.chatter_user_name || e.chatter_user_login,
          text: (e.message && e.message.text) || '',
          roles: rolesFromBadges(e.badges, e.chatter_user_id === this.broadcasterId),
        });
        return;
      }

      if (type === 'revocation') {
        this.setStatus('error', 'subscription revoked - re-authorize at /auth/twitch');
      }
    });

    ws.addEventListener('close', () => {
      this.clearKeepalive();
      if (!this.stopped) this.scheduleReconnect('socket closed');
    });
    ws.addEventListener('error', () => { /* a close event always follows */ });
  }

  /* EventSub hands us a fresh URL before dropping the old socket. */
  swap(url) {
    const old = this.ws;
    const ws = this.ws = new WebSocket(url);
    ws.addEventListener('open', () => { try { old.close(); } catch {} });
    ws.addEventListener('message', ev => {
      try {
        if (JSON.parse(ev.data).metadata.message_type === 'session_welcome') this.connectEventSub();
      } catch {}
    });
  }

  armKeepalive(ms) {
    this.keepaliveMs = ms || this.keepaliveMs || 10000;
    clearTimeout(this.keepaliveTimer);
    // Twitch promises a keepalive every N seconds; silence past 2N means a dead socket.
    this.keepaliveTimer = setTimeout(() => {
      this.log.warn('no keepalive - dropping socket');
      try { this.ws.close(); } catch {}
    }, this.keepaliveMs * 2 + 2000);
  }

  clearKeepalive() { clearTimeout(this.keepaliveTimer); }

  connectIrc() {
    const nick = 'justinfan' + (10000 + Math.floor(Math.random() * 80000));
    const ws = this.ws = new WebSocket(IRC_WS);
    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${this.channel}`);
      this.attempt = 0;
      this.writable = false;
      this.setStatus('connected', `irc (anonymous, read-only) - #${this.channel}`);
    });
    ws.addEventListener('message', ev => {
      for (const line of String(ev.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const m = parseIrc(line);
        if (m) this.emit(m);
      }
    });
    ws.addEventListener('close', () => { if (!this.stopped) this.scheduleReconnect('irc closed'); });
    ws.addEventListener('error', () => {});
  }

  async say(text) {
    if (!this.writable) return;
    await this.helix('/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        broadcaster_id: this.broadcasterId,
        sender_id: this.selfId,
        message: text,
      }),
    });
  }

  stop() {
    super.stop();
    this.clearKeepalive();
    try { if (this.ws) this.ws.close(); } catch {}
  }
}

export function rolesFromBadges(badges, isBroadcaster) {
  const set = new Set((badges || []).map(b => b.set_id));
  return {
    broadcaster: isBroadcaster || set.has('broadcaster'),
    mod: set.has('moderator'),
    vip: set.has('vip'),
    sub: set.has('subscriber') || set.has('founder'),
  };
}

/* Minimal IRCv3 PRIVMSG parser - enough for tags plus message text. Exported for tests. */
export function parseIrc(line) {
  let rest = line;
  const tags = {};
  if (rest[0] === '@') {
    const sp = rest.indexOf(' ');
    for (const kv of rest.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1);
    }
    rest = rest.slice(sp + 1);
  }
  const at = rest.indexOf(' PRIVMSG ');
  if (at < 0) return null;
  const textAt = rest.indexOf(' :', at);
  if (textAt < 0) return null;
  const text = rest.slice(textAt + 2);
  const badges = (tags.badges || '').split(',').filter(Boolean).map(b => b.split('/')[0]);
  const login = (rest.match(/^:([^!]+)!/) || [])[1] || '';
  return {
    userId: tags['user-id'] || login,
    display: tags['display-name'] || login,
    text,
    roles: {
      broadcaster: badges.includes('broadcaster'),
      mod: tags.mod === '1' || badges.includes('moderator'),
      vip: badges.includes('vip'),
      sub: tags.subscriber === '1' || badges.includes('subscriber') || badges.includes('founder'),
    },
  };
}
