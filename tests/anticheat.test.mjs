/* Пограничные случаи со стороны зрителя: что он может выжать из чата.
   Роутер и сессия поднимаются напрямую, с фальшивым хабом вместо оверлея —
   так видно ровно то, что хост отправил бы в игру. */
import { ChatBus } from '../server/bus.mjs';
import { CommandRouter } from '../server/router.mjs';
import { Session } from '../server/session.mjs';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ' — ' + extra : ''}`); };

const CFG = over => ({
  game: { lobbySeconds: 45, minPlayers: 2, winners: 1, autoStart: true, simulateBots: 0 },
  commands: {
    prefix: '!', join: 'join', admin: 'meteor',
    adminRoles: ['broadcaster', 'mod'], islandChoiceRoles: ['everyone'], joinRoles: ['everyone'],
    ...(over && over.commands),
  },
  limits: { userBurst: 3, userWindowMs: 10000, joinsPerSecond: 40, dedupeMs: 2000, ...(over && over.limits) },
  replies: 'off',
});

function rig(over) {
  const cfg = CFG(over);
  const sent = [];
  const hub = { send: m => sent.push(m) };
  const outbox = { announce() {}, say() {} };
  const session = new Session({ cfg, hub, outbox });
  const bus = new ChatBus(cfg);
  const router = new CommandRouter({ cfg, session, outbox });
  bus.on('message', m => router.handle(m));
  const say = (userId, text, roles, platform) => bus.push({ platform: platform || 'twitch', userId, display: 'u' + userId, text, roles: roles || {} });
  const joins = () => sent.filter(m => m.t === 'join');
  return { cfg, session, router, say, sent, joins, mod: (t) => say('1', t, { mod: true }) };
}

/* ---- кто вообще может играть ---- */
{
  const r = rig({ commands: { joinRoles: ['sub', 'vip', 'mod', 'broadcaster'] } });
  r.mod('!meteor start');
  r.say('100', '!join');                    // обычный зритель
  r.say('101', '!join', { sub: true });
  r.say('102', '!join', { vip: true });
  check('joinRoles не пускает в игру посторонних', r.joins().length === 2 && !r.joins().some(j => j.key === 'twitch:100'),
    r.joins().map(j => j.key).join(','));
  check('и не заводит им место в ростере', r.session.roster.size === 2, `roster=${r.session.roster.size}`);
}
{
  const r = rig();
  r.mod('!meteor start');
  r.say('100', '!join');
  check('по умолчанию играют все', r.joins().length === 1);
}

/* ---- выбор острова ---- */
{
  const r = rig({ commands: { islandChoiceRoles: ['sub'] } });
  r.mod('!meteor start');
  r.say('100', '!join 3');
  r.say('101', '!join 3', { sub: true });
  check('!join N без права на выбор становится обычным !join',
    r.joins().find(j => j.key === 'twitch:100').choice === 0 && r.joins().find(j => j.key === 'twitch:101').choice === 3);
}
{
  const r = rig();
  r.mod('!meteor start');
  for (const t of ['!join 0', '!join 4', '!join -1', '!join 99', '!join abc', '!join 2.9', '!join  2  ', '!join 1e1'])
    r.say('2' + t.length + t.charCodeAt(6), t);
  const bad = r.joins().filter(j => !(j.choice >= 0 && j.choice <= 3));
  check('номер острова вне 1..3 никуда не проходит', bad.length === 0, JSON.stringify(bad));
  check('"!join 2.9" и "!join  2  " читаются как остров 2',
    r.joins().filter(j => j.choice === 2).length === 2, JSON.stringify(r.joins().map(j => j.choice)));
}

/* ---- одна личность — одно место ---- */
{
  const r = rig({ limits: { userBurst: 100 } });
  r.mod('!meteor start');
  for (const t of ['!join 1', '!join 2', '!join 3', '!join 1']) r.say('100', t);
  check('перезаход не множит места в ростере', r.session.roster.size === 1, `roster=${r.session.roster.size}`);
  check('последний выбор и есть текущий', r.session.roster.get('twitch:100').choice === 1);
  // Регистр ника в Twitch может приезжать по-разному; личность — числовой id.
  r.say('100', '!JOIN 2');
  check('регистр команды не создаёт вторую личность', r.session.roster.size === 1);
}

/* ---- лимиты ---- */
{
  const r = rig();
  r.mod('!meteor start');
  for (let i = 0; i < 12; i++) r.say('100', `!join ${1 + i % 3}`);
  check('перескоки по островам упираются в userBurst', r.joins().length <= 3, `${r.joins().length} шт.`);
  check('и это учтено как сброшенное по лимиту', r.router.dropped.rateUser > 0);
}
{
  const r = rig({ limits: { joinsPerSecond: 5 } });
  r.mod('!meteor start');
  for (let i = 0; i < 40; i++) r.say('2' + i, '!join');
  check('общий потолок джойнов в секунду держит', r.joins().length === 5, `${r.joins().length} шт.`);
}

/* ---- права ---- */
{
  const r = rig({ limits: { userBurst: 100 } });
  for (const t of ['!meteor start', '!meteor go', '!meteor reset', '!meteor winners 20'])
    r.say('666', t, { sub: true, vip: true });
  check('саб и VIP не управляют игрой', r.sent.filter(m => m.t === 'cmd').length === 0, JSON.stringify(r.sent));
  check('и это видно в счётчике отказов', r.router.dropped.perms === 4, `perms=${r.router.dropped.perms}`);
}

/* ---- вне лобби ---- */
{
  const r = rig();
  r.mod('!meteor start');
  r.say('100', '!join');
  r.say('101', '!join');
  await r.session.close();                 // набор закрыт, матч идёт на хосте
  r.sent.length = 0;
  r.say('200', '!join 2');
  check('после закрытия набора !join не доходит до оверлея', r.joins().length === 0);
  check('и не заводит места в ростере', !r.session.roster.has('twitch:200'));
  check('учтено как сброшенное по фазе', r.router.dropped.phase === 1);
  check('состав матча — ровно те, кто был до закрытия',
    r.session.match.params.roster.map(x => x[0]).join(',') === 'twitch:100,twitch:101');
  r.session.reset(true);
}

/* ---- место решает хост ----

   Раньше остров подтверждал оверлей, и его отчёт мог переписать ростер. Теперь
   рассаживает хост, а отчёты оверлея на состав не влияют вовсе: иначе любая
   вкладка с оверлеем могла бы пересадить игрока или выкинуть его из розыгрыша. */
{
  const r = rig();
  r.mod('!meteor start');
  r.say('100', '!join 1');
  const seat = r.joins().find(j => j.key === 'twitch:100');
  check('хост сам назначает остров и шлёт его оверлею', seat && seat.island === 1, JSON.stringify(seat));
  r.session.report({ type: 'joinResult', key: 'twitch:100', ok: false });
  r.session.report({ type: 'joinResult', key: 'twitch:100', ok: true, island: 3 });
  r.session.report({ type: 'phase', phase: 'won', alive: 0 });
  check('отчёты оверлея не трогают ростер', r.session.roster.get('twitch:100')?.island === 1,
    JSON.stringify(r.session.roster.get('twitch:100')));
  check('и не двигают фазу', r.session.phase === 'lobby', r.session.phase);
  r.say('300', '!join');
  check('автоматический остров тоже назначает хост', r.session.roster.get('twitch:300')?.island >= 1);
  r.session.reset(true);
}

/* ---- дедуп и мусор ---- */
{
  const r = rig();
  r.mod('!meteor start');
  r.say('100', '!join 2');
  r.say('100', '!join 2');
  check('повтор того же текста отбрасывается шиной', r.joins().length === 1);
  r.sent.length = 0;
  // Пробелы по краям шина срезает сама, поэтому " !join" — обычный !join и в
  // этот список не входит.
  for (const t of ['!joiner', '!join2', 'join', '!', '!!join', '!meteor', '!meteor winners 0', '!meteor winners 21'])
    r.say('400', t);
  check('похожий на команду мусор ничего не делает', r.sent.filter(m => m.t !== 'phase').length === 0,
    JSON.stringify(r.sent.filter(m => m.t !== 'phase')));
}

/* ---- личность ---- */
{
  const r = rig();
  r.mod('!meteor start');
  r.say('100', '!join 1');
  // Один и тот же id на двух платформах — два разных человека, два места.
  // Обратная сторона: один человек с аккаунтами на Twitch и Kick занимает два
  // места, и по чату это неотличимо. Лечится только joinRoles.
  r.say('100', '!join 1', {}, 'kick');
  check('ключ личности включает платформу', r.joins().every(j => j.key.includes(':')));
  check('twitch:100 и kick:100 — разные места', r.session.roster.size === 2,
    [...r.session.roster.keys()].join(','));
}
{
  // Пустой userId дальше шины не идёт: иначе все безымянные сообщения слились бы
  // в одну личность и в один лимит.
  const r = rig();
  r.mod('!meteor start');
  r.sent.length = 0;
  for (const id of ['', '   ', null, undefined]) r.say(id, '!join');
  check('сообщение без id личности игнорируется', r.joins().length === 0, JSON.stringify(r.joins()));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
