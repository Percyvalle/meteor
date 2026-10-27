/* Матч целиком живёт на хосте. Оверлей рисует ту же симуляцию тем же ядром,
   но исход решает хост: он рассаживает игроков в лобби, закрывает набор,
   выводит сид из состава и случайности и сам прогоняет матч с фиксированным
   шагом в реальном времени. Победителя поэтому не знает никто, пока его не
   покажет экран, а потом его может пересчитать любой (public/verify.html). */
import { randomInt, randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Game, STEP, buildMatch } from '../public/js/core.js';
import { RULE, DRAND, canonRoster, rosterHash, drawSeed, roundAt, roundTime, fetchRound } from '../public/js/draw.js';
import { makeBots } from '../public/js/bots.js';
import { ROOT } from './config.mjs';
import { Journal } from './journal.mjs';
import { logger } from './log.mjs';

const log = logger('session');

/* Версия ядра входит в запись розыгрыша: любая правка баланса меняет исход
   при том же сиде. Переводы строк нормализуются — иначе один и тот же файл из
   git на Windows и на Linux давал бы разные хэши. */
export const CORE_HASH = createHash('sha256')
  .update(readFileSync(resolve(ROOT, 'public/js/core.js'), 'utf8').replace(/\r\n/g, '\n'))
  .digest('hex');

const short = h => h ? `${h.slice(0, 4)}…${h.slice(-4)}`.toUpperCase() : '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Session {
  /* drand и wait — подмены для тестов: свой fetchRound и ожидание без часов. */
  constructor({ cfg, hub, outbox, journal, drand, wait }) {
    this.cfg = cfg; this.hub = hub; this.outbox = outbox;
    this.giveaway = !!(cfg.giveaway && cfg.giveaway.enabled);
    this.journal = journal || (this.giveaway ? new Journal(cfg.giveaway.journal) : null);
    this.fetchRound = drand || fetchRound;
    this.wait = wait || sleep;
    this.counter = 0;
    this.token = 0;
    this.reset(true);
  }

  reset(silent, reason) {
    this.annul(reason || 'сброс');
    clearInterval(this.tick); this.tick = null;
    clearInterval(this.sim); this.sim = null;
    clearTimeout(this.botTimer); this.botTimer = null;
    this.token++;                 // отменяет закрытие набора, если оно ещё ждёт drand
    this.layout = 0;
    this.phase = 'idle';
    this.winners = this.cfg.game.winners;
    this.lobbyDur = this.cfg.game.lobbySeconds;
    this.lobbyLeft = 0;
    this.roster = new Map();
    this.lobbyGame = null;
    this.match = null;
    this.draw = null;
    this.lastWinners = [];
    this.warned = new Set();
    if (!silent) {
      this.hub.send({ t: 'cmd', name: 'reset' });
      this.push();
    }
  }

  /* Розыгрыш, которому уже выдан номер, не исчезает молча: сброс посреди него
     попадает в журнал и в чат. */
  annul(reason) {
    const d = this.draw;
    if (!d || d.done) return;
    d.done = true;
    d.status = 'annulled';
    log.warn(`розыгрыш #${d.no} аннулирован: ${reason}`);
    if (this.journal) this.journal.append({ draw: d.no, status: 'annulled', reason, at: new Date().toISOString() });
    this.hub.send({ t: 'cmd', name: 'annul', draw: d.no, reason });
    if (this.giveaway) this.outbox.announce('annulled', { draw: d.no, reason });
  }

  game() { return this.match ? this.match.game : this.lobbyGame; }

  drawInfo() {
    const d = this.draw;
    if (!d) return null;
    return {
      no: d.no, giveaway: this.giveaway, players: d.roster.length, rosterHash: d.rosterHash,
      round: d.round, randomness: d.randomness || null, seedHex: d.seedHex || null,
      source: d.source, status: d.status,
    };
  }

  snapshot() {
    const g = this.game();
    const played = !!this.match;
    return {
      open: this.phase === 'lobby',
      phase: this.phase,
      giveaway: this.giveaway,
      seed: this.layout,
      winners: this.winners,
      lobbyDur: this.lobbyDur,
      lobbyLeft: Math.max(0, Math.round(this.lobbyLeft)),
      minPlayers: this.cfg.game.minPlayers,
      waiting: this.phase === 'lobby' && this.roster.size < this.need(),
      alive: g ? g.alive : 0,
      players: this.roster.size,
      // До закрытия набора опасность и квоты ещё не существуют: их роллит
      // итоговый сид. Показывать уровни лобби значило бы показывать мусор.
      islands: g ? g.islands.filter(i => i.id < 3).map(i => ({
        id: i.id + 1, name: i.prof.name,
        danger: played ? i.danger : 0, quota: played ? i.quota : 0, players: played ? i.n0 : i.n,
      })) : [],
      simulate: false,
      bots: 0,
      roster: [...this.roster.values()],
      lastWinners: this.lastWinners,
      draw: this.drawInfo(),
      match: this.match ? { params: this.match.params, steps: this.match.steps } : null,
    };
  }

  push() { this.hub.send({ t: 'phase', session: this.publicSnapshot() }); }

  rosterList() { return [...this.roster.values()]; }

  /* Ростер и параметры матча — сотни записей, в ежесекундный пуш они не идут.
     Панель получает ростер один раз при подключении и дальше ведёт его сама. */
  publicSnapshot() {
    const s = this.snapshot();
    delete s.roster;
    delete s.match;
    return s;
  }

  /* Полная запись розыгрыша — то, что вставляется в страницу проверки. */
  record(no) {
    if (this.journal) return this.journal.get(no || this.journal.last);
    const d = this.draw;
    if (!d || !d.seedHex) return null;
    return {
      draw: d.no, rule: RULE, core: CORE_HASH, layout: d.layout, winners: d.winners,
      roster: d.roster, rosterHash: d.rosterHash, drand: null, randomness: d.randomness,
      seed: d.seedHex, result: d.result || null, status: d.status,
    };
  }

  /* opts.keepRoster: новое лобби с теми же участниками на тех же островах. */
  start(opts) {
    const keep = !!(opts && opts.keepRoster);
    const winners = this.winners;
    const kept = keep ? [...this.roster.values()] : [];
    this.reset(true, keep ? 'перезапуск лобби' : 'новое лобби');
    this.winners = winners;
    this.layout = randomInt(0, 2 ** 31) >>> 0;
    this.lobbyGame = new Game(this.layout, this.winners);
    this.lobbyGame.openLobby();
    this.phase = 'lobby';
    this.lobbyDur = this.cfg.game.lobbySeconds;
    this.lobbyLeft = this.lobbyDur;
    log.info(`lobby open — ${this.winners} winner(s), ${this.lobbyDur}s`
      + (keep ? `, ${kept.length} player(s) kept` : '') + (this.giveaway ? ', режим розыгрыша' : ''));
    this.hub.send({
      t: 'cmd', name: 'start', keep, giveaway: this.giveaway,
      seed: this.layout, winners: this.winners, lobby: this.lobbyDur, min: this.cfg.game.minPlayers,
    });
    for (const p of kept) this.seat(p, p.island);
    if (keep) this.outbox.announce('lobbyRestart', { seconds: this.lobbyDur, players: this.roster.size, min: this.need() });
    else this.outbox.announce('lobbyOpen', { seconds: this.lobbyDur, min: this.need() });
    if (this.cfg.game.simulateBots > 0 && !this.giveaway) this.feedBots(this.cfg.game.simulateBots);
    this.tick = setInterval(() => this.onTick(), 1000);
    this.push();
  }

  /* Тестовые боты — обычные участники хоста, иначе их не было бы в составе
     матча. В режиме розыгрыша их нет вовсе. */
  feedBots(n) {
    const queue = makeBots(n);
    const every = Math.max(10, (this.lobbyDur * 700) / queue.length);
    const step = () => {
      if (this.phase !== 'lobby' || !queue.length) return;
      const b = queue.shift();
      this.seat({ key: b.key, display: b.display, platform: b.platform, choice: b.choice }, b.choice);
      this.botTimer = setTimeout(step, every);
    };
    this.botTimer = setTimeout(step, every);
  }

  /* Место решает хост: его лобби — единственное, где рассадка не зависит от
     кадров. Оверлей получает уже готовый остров. */
  seat(p, choice) {
    const r = this.lobbyGame.addPlayer({ key: p.key, display: p.display, platform: p.platform }, choice);
    if (!r) return null;
    const entry = { key: r.key, display: r.name, platform: p.platform, choice: p.choice | 0, island: r.island + 1 };
    this.roster.set(entry.key, entry);
    this.hub.send({ t: 'join', key: entry.key, display: entry.display, platform: entry.platform, choice: entry.choice, island: entry.island });
    return entry;
  }

  need() { return this.cfg.game.minPlayers; }

  onTick() {
    if (this.phase !== 'lobby') { clearInterval(this.tick); this.tick = null; return; }
    // Пустое лобби, отсчитывающее в никуда, на стриме выглядит сломанным.
    if (this.roster.size < this.need()) { this.push(); return; }
    if (this.lobbyLeft > 0) this.lobbyLeft -= 1;
    for (const mark of [30, 10]) {
      if (this.lobbyLeft <= mark && !this.warned.has(mark) && this.lobbyDur > mark + 5) {
        this.warned.add(mark);
        this.outbox.announce('lobbyClosing', { seconds: mark, players: this.roster.size });
      }
    }
    if (this.lobbyLeft <= 0 && this.cfg.game.autoStart) this.go();
    this.push();
  }

  go() {
    return this.close().catch(e => { log.error(`закрытие набора: ${e.stack || e.message}`); return false; });
  }

  /* Закрытие набора. Порядок важен: сначала фиксируется и публикуется состав,
     потом назначается раунд drand, которого ещё нет, и только после его выхода
     появляется сид. Повлиять на исход после закрытия нечем, до — не на что. */
  async close() {
    if (this.phase !== 'lobby') return false;
    if (this.roster.size < 2) {
      this.lobbyLeft = 10; this.lobbyDur = 10;
      this.push();
      return false;
    }
    clearInterval(this.tick); this.tick = null;
    clearTimeout(this.botTimer); this.botTimer = null;
    const token = this.token;
    this.phase = 'sealing';
    const roster = canonRoster([...this.roster.values()].map(p => [p.key, p.display, p.island]));
    const hash = await rosterHash(roster);
    if (token !== this.token) return false;
    const no = this.journal ? this.journal.reserve() : ++this.counter;
    const round = this.giveaway ? roundAt(Date.now()) + 2 : 0;
    const d = this.draw = {
      no, layout: this.layout, winners: this.winners, roster, rosterHash: hash, round,
      source: this.giveaway ? 'drand' : 'local', status: 'sealed', closedAt: new Date().toISOString(),
    };
    if (this.journal) this.journal.append({
      draw: no, status: 'sealed', rule: RULE, core: CORE_HASH, closedAt: d.closedAt,
      layout: d.layout, winners: d.winners, rosterHash: hash, roster,
      drand: this.giveaway ? { chain: DRAND.chain, round } : null,
    });
    log.info(`розыгрыш #${no}: набор закрыт, ${roster.length} участников, список ${hash}` + (round ? `, drand раунд ${round}` : ''));
    this.hub.send({ t: 'cmd', name: 'seal', draw: no, players: roster.length, rosterHash: hash, round, giveaway: this.giveaway });
    if (this.giveaway) this.outbox.announce('sealed', { draw: no, players: roster.length, hash: short(hash), round });
    this.push();

    let randomness;
    try {
      randomness = this.giveaway ? await this.awaitRound(round, token) : randomBytes(32).toString('hex');
    } catch (e) {
      if (token !== this.token) return false;
      this.annul(`drand недоступен (${e.message})`);
      this.phase = 'idle';           // состав сохранён: !meteor restart начнёт новый розыгрыш с ним
      this.push();
      return false;
    }
    if (token !== this.token) return false;
    const { seed, seedHex } = await drawSeed({ draw: no, layout: d.layout, winners: d.winners, rosterHash: hash, randomness });
    if (token !== this.token) return false;
    Object.assign(d, { randomness, seed, seedHex, status: 'started' });
    if (this.journal) this.journal.append({
      draw: no, status: 'started', randomness, seed: seedHex,
      drand: this.giveaway ? { chain: DRAND.chain, round, randomness, signature: d.signature } : null,
    });
    this.begin({ layout: d.layout, seed, winners: d.winners, roster });
    return true;
  }

  async awaitRound(round, token) {
    const wait = roundTime(round) - Date.now() + 300;
    if (wait > 0) await this.wait(wait);
    // ~25 секунд повторов: зеркала drand падают редко и поодиночке.
    for (let attempt = 1; ; attempt++) {
      if (token !== this.token) throw new Error('отменено');
      try {
        const r = await this.fetchRound(round);
        this.draw.signature = r.signature;
        return r.randomness;
      } catch (e) {
        if (attempt >= 25) throw e;
        log.warn(`drand раунд ${round}: ${e.message}, повтор`);
        await this.wait(1000);
      }
    }
  }

  /* Хост ведёт матч сам, шаг за шагом в реальном времени, — так исход не
     известен заранее даже ему. Оверлей считает то же самое и только рисует. */
  begin(params) {
    const game = buildMatch(params);
    game.events.length = 0;
    this.match = { params, game, steps: 0, t0: performance.now() };
    this.phase = game.phase;
    this.hub.send({ t: 'cmd', name: 'match', params, draw: this.drawInfo() });
    this.outbox.announce('matchStart', { players: game.alive, winners: game.winnersN });
    this.sim = setInterval(() => this.advance(), 1000 / 60);
    this.push();
  }

  advance() {
    const m = this.match;
    if (!m) return;
    const due = Math.floor((performance.now() - m.t0) / (STEP * 1000));
    let pushed = false;
    while (m.steps < due && m.game.phase !== 'won') {
      m.game.update(STEP); m.steps++;
      for (const e of m.game.events) {
        if (e.type === 'kill' && this.cfg.replies === 'verbose') {
          this.outbox.announce('kill', { display: e.p.name, place: e.p.place });
        }
        if (e.type === 'go' || e.type === 'transfer' || e.type === 'final') pushed = true;
        if (e.type === 'win') this.finish(e.list);
      }
      m.game.events.length = 0;
    }
    if (this.match && this.match.game.phase !== this.phase) { this.phase = this.match.game.phase; pushed = true; }
    if (pushed || m.steps % 60 === 0) this.push();
  }

  finish(list) {
    clearInterval(this.sim); this.sim = null;
    const d = this.draw;
    this.lastWinners = list.map((p, i) => ({ key: p.key, display: p.name, platform: p.platform, place: i + 1 }));
    this.phase = 'won';
    if (d) {
      d.done = true; d.status = 'completed';
      d.result = { winners: this.lastWinners.map(w => [w.key, w.display]), steps: this.match.steps };
      if (this.journal) this.journal.append({ draw: d.no, status: 'completed', at: new Date().toISOString(), result: d.result });
    }
    log.info(`розыгрыш #${d ? d.no : '?'}: победители ${this.lastWinners.map(w => `${w.display} (${w.key})`).join(', ')}`);
    this.outbox.announce('win', { list: this.lastWinners, draw: this.giveaway && d ? d.no : 0 });
    this.push();
  }

  setWinners(n) {
    if (this.phase !== 'idle' && this.phase !== 'lobby') return;
    this.winners = Math.max(1, Math.min(20, n | 0));
    if (this.lobbyGame) this.lobbyGame.setWinners(this.winners);
    this.hub.send({ t: 'cmd', name: 'winners', value: this.winners });
    this.outbox.announce('winners', { n: this.winners });
    this.push();
  }

  join(p) {
    if (this.phase !== 'lobby') return;
    const prev = this.roster.get(p.key);
    if (prev && prev.choice === p.choice) return;       // тот же запрос дважды
    this.seat(p, p.choice);
  }

  /* Отчёты оверлея больше ничего не решают: исход считает хост. Расхождение
     с ним значит, что оверлей и хост исполняют разное ядро, — это в лог. */
  report(m) {
    if (m.type !== 'win' || !this.match) return;
    const mine = this.lastWinners.map(w => w.key).join('|');
    const theirs = (m.list || []).map(w => w.key).join('|');
    if (mine && theirs !== mine) log.error(`оверлей показал других победителей (${theirs}), чем посчитал хост (${mine})`);
  }
}
