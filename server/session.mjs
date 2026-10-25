/* Authoritative match metadata. The simulation runs in the overlay (it is
   deterministic from the seed); the host owns the seed, the winner count and the
   lobby roster so a reloaded overlay can rebuild the exact same lobby.
   Phase is mirrored from overlay reports, with the lobby gate kept locally so
   joins are accepted or dropped without a round trip. */
import { randomInt } from 'node:crypto';
import { logger } from './log.mjs';

const log = logger('session');

export class Session {
  constructor({ cfg, hub, outbox }) {
    this.cfg = cfg; this.hub = hub; this.outbox = outbox;
    this.reset(true);
  }

  reset(silent) {
    clearInterval(this.tick); this.tick = null;
    this.seed = 0;
    this.phase = 'idle';
    this.winners = this.cfg.game.winners;
    this.lobbyDur = this.cfg.game.lobbySeconds;
    this.lobbyLeft = 0;
    this.roster = new Map();
    this.alive = 0;
    this.islands = [];
    this.lastWinners = [];
    this.warned = new Set();
    if (!silent) {
      this.hub.send({ t: 'cmd', name: 'reset' });
      this.push();
    }
  }

  snapshot() {
    return {
      open: this.phase === 'lobby',
      phase: this.phase,
      seed: this.seed,
      winners: this.winners,
      lobbyDur: this.lobbyDur,
      lobbyLeft: Math.max(0, Math.round(this.lobbyLeft)),
      alive: this.alive,
      players: this.roster.size,
      islands: this.islands,
      simulate: this.cfg.game.simulateBots > 0,
      bots: this.cfg.game.simulateBots,
      roster: [...this.roster.values()],
      lastWinners: this.lastWinners,
    };
  }

  push() { this.hub.send({ t: 'phase', session: this.publicSnapshot() }); }

  /* The roster can be hundreds of entries; the control panel does not need it. */
  publicSnapshot() {
    const s = this.snapshot();
    delete s.roster;
    return s;
  }

  start() {
    // reset() returns everything to the configured defaults, but a winner count
    // set before the lobby opened is a deliberate choice and must survive.
    const winners = this.winners;
    this.reset(true);
    this.winners = winners;
    this.seed = randomInt(0, 2 ** 31) >>> 0;
    this.phase = 'lobby';
    this.lobbyDur = this.cfg.game.lobbySeconds;
    this.lobbyLeft = this.lobbyDur;
    log.info(`lobby open — seed ${this.seed}, ${this.winners} winner(s), ${this.lobbyDur}s`);
    this.hub.send({
      t: 'cmd', name: 'start',
      seed: this.seed, winners: this.winners, lobby: this.lobbyDur,
      simulate: this.cfg.game.simulateBots > 0, bots: this.cfg.game.simulateBots,
    });
    this.outbox.announce('lobbyOpen', { seconds: this.lobbyDur });
    this.tick = setInterval(() => this.onTick(), 1000);
    this.push();
  }

  onTick() {
    if (this.phase !== 'lobby') { clearInterval(this.tick); this.tick = null; return; }
    this.lobbyLeft -= 1;
    for (const mark of [30, 10]) {
      if (this.lobbyLeft <= mark && !this.warned.has(mark) && this.lobbyDur > mark + 5) {
        this.warned.add(mark);
        this.outbox.announce('lobbyClosing', { seconds: mark, players: this.roster.size });
      }
    }
    if (this.lobbyLeft <= 0) {
      clearInterval(this.tick); this.tick = null;
      // The overlay auto-starts on its own timer; this only covers a manual-start config.
      if (!this.cfg.game.autoStart) this.go();
    }
    this.push();
  }

  go() {
    if (this.phase !== 'lobby') return;
    this.hub.send({ t: 'cmd', name: 'go' });
  }

  setWinners(n) {
    if (this.phase !== 'idle' && this.phase !== 'lobby') return;
    this.winners = Math.max(1, Math.min(20, n | 0));
    this.hub.send({ t: 'cmd', name: 'winners', value: this.winners });
    this.outbox.announce('winners', { n: this.winners });
    this.push();
  }

  join(p) {
    const prev = this.roster.get(p.key);
    if (prev && prev.choice === p.choice) return;       // same request twice, nothing to do
    this.roster.set(p.key, { key: p.key, display: p.display, platform: p.platform, choice: p.choice });
    this.hub.send({ t: 'join', key: p.key, display: p.display, platform: p.platform, choice: p.choice });
  }

  /* Reports coming back from the overlay. */
  report(m) {
    switch (m.type) {
      case 'phase':
        this.phase = m.phase || this.phase;
        this.alive = m.alive ?? this.alive;
        if (Array.isArray(m.islands)) this.islands = m.islands;
        if (m.winners) this.winners = m.winners;
        if (this.phase !== 'lobby' && this.tick) { clearInterval(this.tick); this.tick = null; }
        if (this.phase === 'countdown' || this.phase === 'qual') {
          this.outbox.announce('matchStart', { players: m.alive, winners: this.winners });
        }
        this.push();
        break;
      case 'win':
        this.lastWinners = m.list || [];
        this.phase = 'won';
        log.info('winners: ' + this.lastWinners.map(w => w.display).join(', '));
        this.outbox.announce('win', { list: this.lastWinners });
        this.push();
        break;
      case 'kill':
        if (this.cfg.replies === 'verbose') this.outbox.announce('kill', m);
        break;
      case 'joinResult':
        if (!m.ok) this.roster.delete(m.key);
        break;
      case 'newgame':
        break;
    }
  }
}
