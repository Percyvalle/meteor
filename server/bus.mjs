/* ChatBus: the one place platform messages become a single normalized shape.
   Adapters push raw-ish messages in; the router is the only consumer. */
import { EventEmitter } from 'node:events';
import { logger } from './log.mjs';

const log = logger('bus');

export const ROLES = ['broadcaster', 'mod', 'vip', 'sub'];

export class ChatBus extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.seen = new Map();          // key -> { text, at } for dedupe
    this.counts = { twitch: 0, kick: 0, local: 0 };
  }

  /* msg: { platform, userId, display, text, roles } */
  push(msg) {
    const platform = String(msg.platform || '').toLowerCase();
    const userId = String(msg.userId ?? '').trim();
    const display = String(msg.display ?? '').trim();
    const text = String(msg.text ?? '').trim();
    if (!platform || !userId || !text) return;

    const key = `${platform}:${userId}`.toLowerCase();
    const now = Date.now();

    const prev = this.seen.get(key);
    if (prev && prev.text === text && now - prev.at < this.cfg.limits.dedupeMs) return;
    this.seen.set(key, { text, at: now });
    if (this.seen.size > 5000) this.seen.clear();

    const roles = {};
    for (const r of ROLES) roles[r] = !!(msg.roles && msg.roles[r]);
    if (roles.broadcaster) roles.mod = true;   // the broadcaster outranks a mod

    this.counts[platform] = (this.counts[platform] || 0) + 1;
    const out = { platform, userId, key, display: display || userId, text, roles, at: now };
    log.debug(`${platform}/${out.display}: ${text}`);
    this.emit('message', out);
  }
}
