/* Relay transport — what a streamer actually runs.

   No Kick app, no tunnel, no webhook URL: this dials out to the relay and gets
   already-verified chat events back. Outbound HTTPS only, so it works behind NAT,
   firewalls and corporate proxies.

   Two ways to get bound to a channel. The streamer clicks «Подключить Kick» and
   authorizes — the bot can then write to chat. Or, when kick.channel is set and
   nothing is bound yet, the host claims that channel by slug: the relay subscribes
   on its own authority, read-only. The second path is for a streamer who has no
   access to the channel account.

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
    this.mode = '';
    // Слаг канала из конфига: если он есть, хост сам заявит права на канал.
    this.want = String(this.cfg.kick.channel || '').trim().toLowerCase().replace(/^@/, '');
    // Какой слаг мы уже пытались заявить. Не флаг, а значение: иначе смена канала
    // в конфиге не подхватится, пока хост не перезапустят.
    this.claimedSlug = '';
    this.controller = null;
    // Каждой попытке соединения свой номер: поток, который успели обогнать,
    // не должен планировать реконнект и уводить нас в петлю.
    this.gen = 0;
  }

  get auth() { return { authorization: `Bearer ${this.me.key}` }; }
  url(path) { return `${this.base}${path}${path.includes('?') ? '&' : '?'}agent=${this.me.id}`; }

  async connect() {
    if (this.stopped) return;
    if (!this.base) {
      this.fatal('kick.relayUrl не задан в config.json');
      return;
    }

    // Отменяем всё, что осталось от прежних попыток: иначе отложенный реконнект
    // откроет второе соединение поверх живого, релей отцепит первое, и мы
    // будем переподключаться по кругу.
    clearTimeout(this._t);
    if (this.controller) { try { this.controller.abort(); } catch {} }

    const gen = ++this.gen;
    this.setStatus('connecting');

    this.controller = new AbortController();
    const r = await fetch(this.url('/agent/events'), {
      headers: { ...this.auth, accept: 'text/event-stream' },
      signal: this.controller.signal,
    });

    if (gen !== this.gen) { try { await r.body.cancel(); } catch {} return; }
    if (r.status === 401) { this.fatal('релей отверг ключ агента — удалите .agent.json и перезапустите'); return; }
    if (!r.ok) throw new Error(`релей ответил ${r.status}`);

    this.attempt = 0;
    this.setStatus('connected', this.statusDetail());

    // Node has no EventSource, but a streamed fetch body is all SSE really needs.
    this.read(r.body, gen).catch(e => {
      if (!this.stopped && gen === this.gen) this.scheduleReconnect(e.name === 'AbortError' ? 'closed' : e.message);
    });
  }

  async read(body, gen) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (gen !== this.gen) return;         // это соединение уже заменено
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

  /* Метод, а не геттер: `detail` — поле базового класса, setStatus в него пишет. */
  statusDetail() {
    if (!this.linked) return 'релей — Kick ещё не подключён';
    return this.mode === 'app'
      ? `релей — ${this.channel} (только чтение)`
      : `релей — ${this.channel}`;
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
      this.mode = a.mode || '';
      // В режиме 'app' токена владельца нет, поэтому писать в чат нельзя —
      // релей скажет 409, а не промолчит.
      this.writable = a.writable !== undefined ? !!a.writable : this.linked;
      this.setStatus('connected', this.statusDetail());
      this.onStatus && this.onStatus(this);

      // Заявляем права сами, когда канал задан в конфиге и либо ничего не
      // привязано, либо привязан не тот канал. Привязку по авторизации владельца
      // (mode 'oauth') не трогаем никогда — она лучше нашей и её выбрал человек.
      const mismatch = this.linked && this.mode === 'app' && this.channel !== this.want;
      if (this.want && this.claimedSlug !== this.want && (!this.linked || mismatch)) {
        this.claimedSlug = this.want;
        this.claim(this.want).catch(e => {
          this.claimedSlug = '';
          this.log.warn(`не удалось привязать канал ${this.want}: ${e.message}`);
        });
      }
    }
  }

  /* Binds a channel by slug, without anyone authorizing Kick. Read-only. */
  async claim(slug) {
    const r = await fetch(this.url('/agent/claim'), {
      method: 'POST',
      headers: { ...this.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ slug: slug || this.want }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `релей ответил ${r.status}`);
    // Релей пришлёт status по тому же потоку, но ответ уже содержит агента —
    // применяем сразу, чтобы панель не ждала следующего сообщения.
    if (j.agent) this.handle({ t: 'status', agent: j.agent });
    return j.agent;
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
    return {
      ...super.info(),
      transport: 'relay',
      linked: this.linked,
      mode: this.mode,
      channel: this.channel,
      // Слаг из конфига — панель подставляет его в поле привязки.
      wantChannel: this.want,
      agentId: this.me.id,
    };
  }

  stop() {
    this.gen++;                 // осиротевшие потоки больше ничего не планируют
    super.stop();
    try { this.controller && this.controller.abort(); } catch {}
  }
}
