/* Relay transport — what a streamer actually runs.

   No Kick app, no tunnel, no webhook URL: this dials out to the relay and gets
   already-verified chat events back. Outbound HTTPS only, so it works behind NAT,
   firewalls and corporate proxies.

   Identity is a key pair this host generates once and keeps in .agent.json. */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { Adapter } from './base.mjs';
import { ROOT } from '../config.mjs';

const FILE = resolve(ROOT, '.agent.json');

function identity() {
  if (existsSync(FILE)) {
    try {
      const j = JSON.parse(readFileSync(FILE, 'utf8'));
      if (j.id && j.key) return j;
    } catch { /* fall through and regenerate */ }
  }
  const j = { id: randomBytes(16).toString('hex'), key: randomBytes(32).toString('hex'), createdAt: Date.now() };
  writeFileSync(FILE, JSON.stringify(j, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}
  return j;
}

export class RelayAdapter extends Adapter {
  constructor(opts) {
    super('kick', opts);
    this.base = String(this.cfg.kick.relayUrl || '').replace(/\/+$/, '');
    this.me = identity();
    this.linked = false;
    this.channel = '';
    this.controller = null;
  }

  get auth() { return { authorization: `Bearer ${this.me.key}` }; }
  url(path) { return `${this.base}${path}${path.includes('?') ? '&' : '?'}agent=${this.me.id}`; }

  async connect() {
    if (this.stopped) return;
    if (!this.base) {
      this.fatal('kick.relayUrl не задан в config.json');
      return;
    }
    this.setStatus('connecting');

    this.controller = new AbortController();
    const r = await fetch(this.url('/agent/events'), {
      headers: { ...this.auth, accept: 'text/event-stream' },
      signal: this.controller.signal,
    });

    if (r.status === 401) { this.fatal('релей отверг ключ агента — удалите .agent.json и перезапустите'); return; }
    if (!r.ok) throw new Error(`релей ответил ${r.status}`);

    this.attempt = 0;
    this.setStatus('connected', this.linked ? `релей — ${this.channel}` : 'релей — Kick ещё не подключён');

    // Node has no EventSource, but a streamed fetch body is all SSE really needs.
    this.read(r.body).catch(e => {
      if (!this.stopped) this.scheduleReconnect(e.name === 'AbortError' ? 'closed' : e.message);
    });
  }

  async read(body) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!this.stopped) this.scheduleReconnect('поток релея закрыт');
        return;
      }
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split('\n\n');
      buf = chunks.pop();
      for (const c of chunks) {
        const line = c.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;                       // keepalive comment
        let m;
        try { m = JSON.parse(line.slice(6)); } catch { continue; }
        this.handle(m);
      }
    }
  }

  handle(m) {
    if (m.t === 'chat') {
      // Already verified against Kick's signature on the relay; pass it straight on.
      if (m.msg) this.emit(m.msg);
      return;
    }
    if (m.t === 'hello' || m.t === 'status') {
      const a = m.agent || {};
      this.linked = !!a.linked;
      this.channel = a.channel || '';
      this.writable = this.linked;
      this.setStatus('connected', this.linked ? `релей — ${this.channel}` : 'релей — Kick ещё не подключён');
      this.onStatus && this.onStatus(this);
    }
  }

  /* Returns a one-time URL the streamer opens to authorize Kick. */
  async linkUrl() {
    const r = await fetch(this.url('/agent/link'), { method: 'POST', headers: this.auth });
    if (!r.ok) throw new Error(`релей ответил ${r.status}`);
    const j = await r.json();
    return j.url;
  }

  async unlink() {
    await fetch(this.url('/agent/unlink'), { method: 'POST', headers: this.auth });
  }

  async say(text) {
    if (!this.writable) return;
    const r = await fetch(this.url('/agent/say'), {
      method: 'POST',
      headers: { ...this.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) throw new Error(`релей ответил ${r.status} при отправке в чат`);
  }

  info() {
    return { ...super.info(), transport: 'relay', linked: this.linked, channel: this.channel, agentId: this.me.id };
  }

  stop() {
    super.stop();
    try { this.controller && this.controller.abort(); } catch {}
  }
}
