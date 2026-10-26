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
      minPlayers: this.cfg.game.minPlayers,
      waiting: this.phase === 'lobby' && this.roster.size < this.need(),
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

  rosterList() { return [...this.roster.values()]; }

  /* The roster can be hundreds of entries, so it stays out of the once-a-second
     phase push. The control panel gets it once on connect and then keeps its own
     copy up to date from the 'join' events. */
  publicSnapshot() {
    const s = this.snapshot();
    delete s.roster;
    return s;
  }

  /* opts.keepRoster: re-open the lobby on a fresh seed without losing the
     participants. Everything random (danger levels, quotas, meteor pacing) is
     rolled again, but every kept player is re-seated on the island they ended
     up on last time; during the lobby they are still free to switch with
     !join N, and newcomers can still join. */
  start(opts) {
    const keep = !!(opts && opts.keepRoster);
    // reset() returns everything to the configured defaults, but a winner count
    // set before the lobby opened is a deliberate choice and must survive.
    const winners = this.winners;
    const kept = keep ? this.roster : null;
    this.reset(true);
    this.winners = winners;
    if (kept) this.roster = kept;
    this.seed = randomInt(0, 2 ** 31) >>> 0;
    this.phase = 'lobby';
    this.lobbyDur = this.cfg.game.lobbySeconds;
    this.lobbyLeft = this.lobbyDur;
    log.info(`lobby open — seed ${this.seed}, ${this.winners} winner(s), ${this.lobbyDur}s`
      + (keep ? `, ${this.roster.size} player(s) kept` : ''));
    this.hub.send({
      t: 'cmd', name: 'start', keep,
      seed: this.seed, winners: this.winners, lobby: this.lobbyDur, min: this.cfg.game.minPlayers,
      simulate: this.cfg.game.simulateBots > 0, bots: this.cfg.game.simulateBots,
    });
    // The overlay rebuilt an empty lobby from the seed; hand it the roster back.
    // `seat()` is the island they actually stood on, so an automatic pick made in
    // the previous round is honoured instead of being re-rolled.
    if (keep) for (const p of this.roster.values()) {
      this.hub.send({ t: 'join', key: p.key, display: p.display, platform: p.platform, choice: this.seat(p) });
    }
    if (keep) this.outbox.announce('lobbyRestart', { seconds: this.lobbyDur, players: this.roster.size, min: this.need() });
    else this.outbox.announce('lobbyOpen', { seconds: this.lobbyDur, min: this.need() });
    this.tick = setInterval(() => this.onTick(), 1000);
    this.push();
  }

  /* Island to put a kept player back on: the one the overlay reported for them,
     falling back to their explicit choice (0 = let the overlay decide). */
  seat(p) { return p.island || p.choice || 0; }

  /* How many joins the countdown waits for. Simulated bots never reach the host
     roster, so with them on the gate would never open and is simply off. */
  need() { return this.cfg.game.simulateBots > 0 ? 0 : this.cfg.game.minPlayers; }

  onTick() {
    if (this.phase !== 'lobby') { clearInterval(this.tick); this.tick = null; return; }
    // An empty lobby counting down to nothing reads as broken on stream, and the
    // match cannot start anyway. Hold the clock until there is someone to play.
    if (this.roster.size < this.need()) { this.push(); return; }
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
    // `island` is where the overlay actually seated them; it survives a re-join
    // until the next joinResult corrects it, so a restart never loses the seat.
    this.roster.set(p.key, {
      key: p.key, display: p.display, platform: p.platform, choice: p.choice,
      island: p.choice || (prev ? prev.island : 0) || 0,
    });
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
        // A report an overlay was still finishing when the lobby opened can land
        // right after start() and stop the clock for good. The next report says
        // 'lobby' again, so revive the ticker instead of staying frozen.
        else if (this.phase === 'lobby' && !this.tick && this.lobbyLeft > 0) {
          this.tick = setInterval(() => this.onTick(), 1000);
        }
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
      case 'joinResult': {
        if (!m.ok) { this.roster.delete(m.key); break; }
        const e = this.roster.get(m.key);
        if (e && m.island) e.island = m.island;
        break;
      }
      case 'newgame':
        break;
    }
  }
}
