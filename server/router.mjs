/* CommandRouter: parses commands, enforces roles and rate limits, then drives
   the session. It is the only component allowed to mutate match state. */
import { logger } from './log.mjs';

const log = logger('router');

class Buckets {
  constructor(burst, windowMs) { this.burst = burst; this.windowMs = windowMs; this.m = new Map(); }
  take(key) {
    const now = Date.now();
    let b = this.m.get(key);
    if (!b || now - b.t0 >= this.windowMs) { b = { t0: now, n: 0 }; this.m.set(key, b); }
    if (b.n >= this.burst) return false;
    b.n++;
    if (this.m.size > 5000) for (const [k, v] of this.m) if (now - v.t0 > this.windowMs) this.m.delete(k);
    return true;
  }
}

export class CommandRouter {
  constructor({ cfg, session, outbox }) {
    this.cfg = cfg; this.session = session; this.outbox = outbox;
    this.buckets = new Buckets(cfg.limits.userBurst, cfg.limits.userWindowMs);
    this.joinWindow = { t0: 0, n: 0 };
    this.dropped = { rateUser: 0, rateJoin: 0, phase: 0, perms: 0 };
  }

  allowed(roles, allow) {
    if (!allow || allow.includes('everyone')) return true;
    return allow.some(r => roles[r]);
  }

  joinBudget() {
    const now = Date.now();
    if (now - this.joinWindow.t0 >= 1000) this.joinWindow = { t0: now, n: 0 };
    if (this.joinWindow.n >= this.cfg.limits.joinsPerSecond) return false;
    this.joinWindow.n++;
    return true;
  }

  handle(m) {
    const C = this.cfg.commands;
    const text = m.text.toLowerCase();
    if (!text.startsWith(C.prefix)) return;
    const body = text.slice(C.prefix.length).trim();
    if (!body) return;
    const [verb, ...rest] = body.split(/\s+/);
    const arg = rest.join(' ');

    if (!this.buckets.take(m.key)) { this.dropped.rateUser++; return; }

    if (verb === C.join) {
      if (!this.allowed(m.roles, C.joinRoles)) { this.dropped.perms++; return; }
      let choice = 0;
      if (arg) {
        const n = parseInt(arg, 10);
        if (!(n >= 1 && n <= 3)) return;
        choice = this.allowed(m.roles, C.islandChoiceRoles) ? n : 0;
      }
      if (this.session.phase !== 'lobby') { this.dropped.phase++; return; }
      if (!this.joinBudget()) { this.dropped.rateJoin++; return; }
      this.session.join({ key: m.key, display: m.display, platform: m.platform, choice });
      return;
    }

    if (verb !== C.admin) return;
    if (!this.allowed(m.roles, C.adminRoles)) { this.dropped.perms++; return; }

    const [sub, subArg] = [rest[0], rest[1]];
    log.info(`admin ${m.platform}/${m.display}: ${body}`);
    switch (sub) {
      case 'start': this.session.start(); break;
      case 'restart': this.session.start({ keepRoster: true }); break;
      case 'go': this.session.go(); break;
      case 'reset': this.session.reset(); break;
      case 'winners': {
        const n = parseInt(subArg, 10);
        if (n >= 1 && n <= 20) this.session.setWinners(n);
        break;
      }
      default: break;
    }
  }
}
