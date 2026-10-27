/* Розыгрыш: что его исход — функция состава и публичной случайности, и ничего
   больше. Хост поднимается без сети и без часов: drand подменён, ожидание
   раунда мгновенное, матч догоняется одним вызовом advance(). */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { ChatBus } from '../server/bus.mjs';
import { CommandRouter } from '../server/router.mjs';
import { Session, CORE_HASH } from '../server/session.mjs';
import { Journal } from '../server/journal.mjs';
import { STEP, buildMatch, runMatch } from '../public/js/core.js';
import { canonRoster, rosterHash, drawSeed, sha256hex, fetchRound, roundAt } from '../public/js/draw.js';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };

const CFG = {
  game: { lobbySeconds: 45, minPlayers: 2, winners: 2, autoStart: true, simulateBots: 0 },
  commands: { prefix: '!', join: 'join', admin: 'meteor', adminRoles: ['broadcaster', 'mod'], islandChoiceRoles: ['everyone'], joinRoles: ['everyone'] },
  limits: { userBurst: 3, userWindowMs: 10000, joinsPerSecond: 1000, dedupeMs: 2000 },
  replies: 'off',
  giveaway: { enabled: true },
};

const fakeDrand = async round => ({ round, randomness: await sha256hex('fake-' + round), signature: '00' });

function rig({ drand = fakeDrand, file } = {}) {
  const path = file || join(tmpdir(), `meteor-draws-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const journal = new Journal(path);
  const sent = [], said = [];
  const hub = { send: m => sent.push(m) };
  const outbox = { announce: (k, d) => said.push([k, d]), say() {} };
  const session = new Session({ cfg: CFG, hub, outbox, journal, drand, wait: async () => {} });
  const bus = new ChatBus(CFG);
  const router = new CommandRouter({ cfg: CFG, session, outbox });
  bus.on('message', m => router.handle(m));
  const say = (id, text, roles, platform) => bus.push({ platform: platform || 'twitch', userId: String(id), display: 'u' + id, text, roles: roles || {} });
  /* Матч на хосте идёт в реальном времени; тест перематывает его до конца. */
  const finish = () => { const m = session.match; m.t0 = performance.now() - 3600e3; session.advance(); };
  return { session, journal, path, sent, said, say, finish, cleanup: () => { session.reset(true); rmSync(path, { force: true }); } };
}

/* То, что делает страница проверки, — без браузера. */
async function verify(rec) {
  const roster = canonRoster(rec.roster);
  const hash = await rosterHash(roster);
  const { seed, seedHex } = await drawSeed({ draw: rec.draw, layout: rec.layout, winners: rec.winners, rosterHash: hash, randomness: rec.randomness });
  const { game, steps } = runMatch({ layout: rec.layout, seed, winners: rec.winners, roster });
  return { hash, seedHex, winners: game.winners.map(p => [p.key, p.name]), steps };
}

/* ---- полный розыгрыш ---- */
{
  const r = rig();
  r.say(1, '!meteor start', { broadcaster: true });
  for (let i = 0; i < 80; i++) r.say(100 + i, i % 5 ? '!join' : `!join ${1 + i % 3}`, {}, i % 2 ? 'twitch' : 'kick');
  check('все заявки в ростере', r.session.roster.size === 80, String(r.session.roster.size));
  const ok = await r.session.close();
  check('набор закрыт и матч начался', ok && !!r.session.match, r.session.phase);
  const seal = r.sent.find(m => m.t === 'cmd' && m.name === 'seal');
  const match = r.sent.find(m => m.t === 'cmd' && m.name === 'match');
  check('сначала публикуется состав, потом матч', seal && match && r.sent.indexOf(seal) < r.sent.indexOf(match));
  check('в момент закрытия сида ещё нет', seal && !('seed' in seal) && !('randomness' in seal));
  check('раунд drand назначен в будущем', seal.round > roundAt(Date.now()) - 1, `round=${seal.round}`);
  r.finish();
  check('хост довёл матч до победителей', r.session.phase === 'won' && r.session.lastWinners.length === 2,
    r.session.lastWinners.map(w => w.display).join(','));

  const rec = r.session.record();
  check('запись собрана из журнала', rec && rec.status === 'completed' && rec.draw === 1, rec && rec.status);
  check('в записи версия ядра', rec.core === CORE_HASH);
  const v = await verify(rec);
  check('хэш состава пересчитывается', v.hash === rec.rosterHash);
  check('сид пересчитывается', v.seedHex === rec.seed);
  check('победители пересчитываются', JSON.stringify(v.winners) === JSON.stringify(rec.result.winners),
    `${JSON.stringify(v.winners)} vs ${JSON.stringify(rec.result.winners)}`);
  check('и за то же число шагов', v.steps === rec.result.steps, `${v.steps} vs ${rec.result.steps}`);

  // Подделки: каждая ломает проверку.
  const extra = { ...rec, roster: [...rec.roster, ['twitch:999', 'alt', 1]] };
  check('лишний участник меняет хэш состава', (await verify(extra)).hash !== rec.rosterHash);
  const moved = { ...rec, roster: rec.roster.map((p, i) => i ? p : [p[0], p[1], p[2] % 3 + 1]) };
  check('пересадка на другой остров меняет хэш', (await verify(moved)).hash !== rec.rosterHash);
  const other = { ...rec, randomness: await sha256hex('other') };
  check('другая случайность — другой сид', (await verify(other)).seedHex !== rec.seed);
  const renamed = { ...rec, roster: rec.roster.map((p, i) => i ? p : [p[0], 'new-nick', p[2]]) };
  check('смена ника на хэш не влияет', (await verify(renamed)).hash === rec.rosterHash);

  // Журнал переживает перезапуск хоста.
  const again = new Journal(r.path);
  check('журнал читается заново', again.get(1)?.status === 'completed' && again.next() === 2);
  r.cleanup();
}

/* ---- оверлей с любыми кадрами считает то же, что хост ---- */
{
  const roster = canonRoster(Array.from({ length: 150 }, (_, i) => [`kick:${i}`, `p${i}`, 1 + i % 3]));
  const params = { layout: 4242, seed: 0xC0FFEE, winners: 3, roster };
  const ref = runMatch(params).game.winners.map(p => p.key).join('|');
  let same = true;
  for (const fps of [24, 30, 59.94, 144]) {
    // Цикл render.js: накопитель реального времени, ровно STEP за update().
    const g = buildMatch(params);
    let acc = 0, t = 0;
    while (g.phase !== 'won' && t < 600) {
      const raw = (1 / fps) * (0.5 + Math.random());         // неровные кадры
      t += raw; acc += raw;
      for (let n = 0; acc >= STEP && n < 12; n++) { g.update(STEP); acc -= STEP; }
      g.events.length = 0;
    }
    const got = g.winners.map(p => p.key).join('|');
    if (got !== ref) { same = false; console.log(`  ${fps} fps: ${got} vs ${ref}`); }
  }
  check('частота и неровность кадров не влияют на исход', same, ref);
}

/* ---- сброс посреди розыгрыша ---- */
{
  let release;
  const slow = round => new Promise(ok => { release = () => ok(fakeDrand(round)); });
  const r = rig({ drand: slow });
  r.say(1, '!meteor start', { broadcaster: true });
  for (let i = 0; i < 5; i++) r.say(100 + i, '!join');
  const pending = r.session.close();
  await new Promise(ok => setImmediate(ok)); await new Promise(ok => setImmediate(ok));
  check('пока ждём drand, фаза — закрытие набора', r.session.phase === 'sealing', r.session.phase);
  r.say(1, '!meteor reset', { broadcaster: true });
  release && release();
  check('сброс не даёт матчу начаться', (await pending) === false && !r.session.match);
  check('розыгрыш аннулирован в журнале', r.journal.get(1)?.status === 'annulled', r.journal.get(1)?.status);
  check('и объявлен в чат', r.said.some(([k, d]) => k === 'annulled' && d.draw === 1));
  r.say(1, '!meteor start', { broadcaster: true });
  for (let i = 0; i < 3; i++) r.say(200 + i, '!join');
  const next = r.session.close();
  for (let i = 0; i < 5 && !r.session.draw?.round; i++) await new Promise(ok => setImmediate(ok));
  await new Promise(ok => setImmediate(ok));
  release(); await next; r.finish();
  check('следующий розыгрыш получает новый номер', r.session.record().draw === 2);
  r.cleanup();
}

/* ---- drand недоступен ---- */
{
  const r = rig({ drand: async () => { throw new Error('offline'); } });
  r.say(1, '!meteor start', { broadcaster: true });
  for (let i = 0; i < 4; i++) r.say(100 + i, '!join');
  const ok = await r.session.close();
  check('без drand матч не начинается', ok === false && !r.session.match);
  check('розыгрыш аннулирован с причиной', /drand/.test(r.journal.get(1)?.reason || ''), r.journal.get(1)?.reason);
  check('состав сохранён для !meteor restart', r.session.roster.size === 4);
  r.say(1, '!meteor restart', { broadcaster: true });
  check('restart возвращает тех же участников', r.session.phase === 'lobby' && r.session.roster.size === 4);
  r.cleanup();
}

/* ---- живой drand (пропускается без сети) ---- */
try {
  const round = roundAt(Date.now()) - 1;
  const got = await fetchRound(round);
  check('живой drand: раунд получен и randomness сходится с подписью', got.round === round);
} catch (e) {
  console.log(`  skip живой drand — ${e.message}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
