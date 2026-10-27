/* Chat replies. Never per-join — 300 joins would flood the chat and burn the
   platform rate limits. Only aggregate announcements, queued and paced. */
import { logger } from './log.mjs';

const log = logger('outbox');

const TEXT = {
  // The lobby clock only starts once `min` players are in, so promising a start
  // time before that would be a lie.
  lobbyOpen: d => `☄ Метеоритный дождь! Пишите !join (или !join 1 / 2 / 3, чтобы выбрать остров). `
    + (d.min > 1 ? `Отсчёт ${d.seconds} с пойдёт, как наберётся участников: ${d.min}.` : `Старт через ${d.seconds} с.`),
  lobbyRestart: d => `☄ Новый раунд! Острова и метеориты перетасованы, участники (${d.players}) остались на своих островах. Сменить — !join 1 / 2 / 3, новым — !join. `
    + (d.min > 1 && d.players < d.min ? `Отсчёт ${d.seconds} с пойдёт, как наберётся участников: ${d.min}.` : `Старт через ${d.seconds} с.`),
  lobbyClosing: d => `☄ ${d.seconds} с до старта — участников: ${d.players}. Успевайте !join`,
  matchStart: d => `☄ Поехали! Участников: ${d.players}. Победителей: ${d.winners}.`,
  winners: d => `☄ Победителей в этой игре: ${d.n}`,
  win: d => (d.draw ? `[розыгрыш #${d.draw}] ` : '') + (d.list.length === 1
    ? `🏆 Победитель — ${d.list[0].display}! Поздравляем!`
    : `🏆 Победители: ${d.list.map((w, i) => `${i + 1}. ${w.display}`).join(' · ')}`),
  // Розыгрыш: состав зафиксирован до того, как кто-либо знает случайность.
  sealed: d => `🔒 Розыгрыш #${d.draw}: набор закрыт, участников ${d.players}. Список ${d.hash}, ждём drand раунд ${d.round}.`,
  annulled: d => `⛔ Розыгрыш #${d.draw} аннулирован: ${d.reason}.`,
  kill: d => `💀 ${d.display} — ${d.place} место`,
};

/* Which announcements each verbosity level lets through. */
const LEVELS = {
  off: [],
  minimal: ['lobbyOpen', 'lobbyRestart', 'lobbyClosing', 'matchStart', 'win', 'sealed', 'annulled'],
  verbose: Object.keys(TEXT),
};

export class Outbox {
  constructor({ cfg }) {
    this.cfg = cfg;
    this.adapters = new Map();        // platform -> adapter with .say(text)
    this.queue = [];
    this.timer = null;
    this.sentWindow = [];             // timestamps, for the shared pacing guard
  }

  register(platform, adapter) { this.adapters.set(platform, adapter); }

  announce(kind, data) {
    const allow = LEVELS[this.cfg.replies] || LEVELS.minimal;
    if (!allow.includes(kind)) return;
    const render = TEXT[kind];
    if (!render) return;
    let text;
    try { text = render(data || {}); } catch (e) { return log.warn(`cannot render ${kind}: ${e.message}`); }
    for (const platform of this.adapters.keys()) this.queue.push({ platform, text });
    this.drain();
  }

  say(platform, text) { this.queue.push({ platform, text }); this.drain(); }

  drain() {
    if (this.timer) return;
    const step = () => {
      // Twitch allows ~20 messages per 30s for a non-mod account; stay far under.
      const now = Date.now();
      this.sentWindow = this.sentWindow.filter(t => now - t < 30000);
      if (!this.queue.length || this.sentWindow.length >= 12) {
        this.timer = null;
        if (this.queue.length) this.timer = setTimeout(step, 2000);
        return;
      }
      const item = this.queue.shift();
      const a = this.adapters.get(item.platform);
      if (a && a.canSay && a.canSay()) {
        this.sentWindow.push(now);
        Promise.resolve(a.say(item.text)).catch(e => log.warn(`${item.platform} send failed: ${e.message}`));
      } else if (a) {
        log.debug(`${item.platform}: reply skipped (no write access)`);
      }
      this.timer = setTimeout(step, 1200);
    };
    this.timer = setTimeout(step, 50);
  }
}
