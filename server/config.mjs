/* Configuration: config.json (optional) <- defaults, with env overrides on top.
   Secrets live in config.json or the environment; they never reach the browser. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.mjs';

const log = logger('config');
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  port: 7777,
  host: '127.0.0.1',
  // Хост обслуживает только свою машину (проверка заголовка Host). Сюда можно
  // дописать имена, под которыми вы открываете панель или оверлей сами — напр.
  // LAN-адрес машины с OBS. Публичный адрес туннеля сюда вписывать нельзя:
  // он открывает панель всему интернету, см. комментарий в server/index.mjs.
  allowedHosts: [],

  game: {
    lobbySeconds: 45,       // how long the lobby accepts !join
    minPlayers: 2,          // the lobby timer holds until this many have joined
    winners: 1,             // 1..20
    autoStart: true,        // start the match when the lobby timer runs out
    simulateBots: 0,        // >0 fills the lobby with N bots (testing)
  },

  commands: {
    prefix: '!',
    join: 'join',
    admin: 'meteor',        // !meteor start|go|reset|winners N
    // who may run admin commands / pick an island
    adminRoles: ['broadcaster', 'mod'],
    islandChoiceRoles: ['everyone'],   // e.g. ['broadcaster','mod','vip','sub'] to gate it
    // Кто вообще может играть. Единственная защита от фермы альтов: одна
    // личность занимает одно место, но завести второй аккаунт на Twitch ничего
    // не стоит. ['sub','vip','mod','broadcaster'] делает это платным.
    joinRoles: ['everyone'],
  },

  limits: {
    userBurst: 3,           // commands allowed per user...
    userWindowMs: 10000,    // ...within this window
    joinsPerSecond: 40,     // global guard so the overlay is never flooded
    dedupeMs: 2000,         // ignore an identical message from the same user
  },

  // Режим розыгрыша: случайность берётся из drand, каждый розыгрыш пишется в
  // журнал, а всё, чем ведущий мог бы подкинуть участника (тестовые сообщения,
  // боты), выключено. Подробности — README, «Розыгрыш с призами».
  giveaway: {
    enabled: false,
    journal: 'draws.jsonl',
  },

  // off | minimal | verbose
  replies: 'minimal',

  twitch: {
    enabled: true,
    channel: '',            // channel login to read, e.g. "somestreamer"
    clientId: '',
    clientSecret: '',
    // eventsub -> official WebSocket (needs auth); irc -> anonymous read-only fallback
    transport: 'auto',
  },

  kick: {
    enabled: true,
    channel: '',            // channel slug
    clientId: '',
    clientSecret: '',
    // ws -> Pusher socket (local, unofficial); webhook -> official API (needs a public URL)
    transport: 'ws',
    chatroomId: 0,          // required when the slug lookup is blocked (see README)
    // Kick rotates the public socket credentials; there is no documented contract
    // for them, so they are config, not constants. README explains where to read
    // the current pair out of the browser in half a minute.
    pusherKey: '',
    pusherCluster: 'us2',
    // transport "webhook": the public https base that Kick will deliver to, e.g.
    // "https://abc-def.trycloudflare.com". Used only to print the setup hint.
    publicUrl: '',
    // transport "relay": the shared relay this host dials out to. Nothing else
    // needs configuring — no Kick app, no tunnel, no webhook URL.
    relayUrl: '',
  },
};

function deepMerge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function fromEnv(cfg) {
  const e = process.env;
  const set = (path, val, cast) => {
    if (val === undefined || val === '') return;
    const parts = path.split('.');
    let o = cfg;
    for (const p of parts.slice(0, -1)) o = o[p];
    o[parts.at(-1)] = cast ? cast(val) : val;
  };
  set('port', e.PORT, Number);
  set('twitch.channel', e.TWITCH_CHANNEL);
  set('twitch.clientId', e.TWITCH_CLIENT_ID);
  set('twitch.clientSecret', e.TWITCH_CLIENT_SECRET);
  set('kick.channel', e.KICK_CHANNEL);
  set('kick.clientId', e.KICK_CLIENT_ID);
  set('kick.clientSecret', e.KICK_CLIENT_SECRET);
  return cfg;
}

export function loadConfig() {
  let file = {};
  const path = resolve(ROOT, 'config.json');
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { log.error(`config.json is not valid JSON: ${e.message}`); process.exit(1); }
  } else {
    log.warn('config.json not found — running on defaults (no channels configured)');
  }
  const cfg = fromEnv(deepMerge(DEFAULTS, file));

  cfg.game.winners = Math.max(1, Math.min(20, cfg.game.winners | 0 || 1));
  cfg.game.lobbySeconds = Math.max(5, Math.min(600, +cfg.game.lobbySeconds || 45));
  // A match needs two players to be a match at all, so 2 is also the floor.
  cfg.game.minPlayers = Math.max(2, Math.min(20, cfg.game.minPlayers | 0 || 2));
  if (cfg.giveaway.enabled && cfg.game.simulateBots > 0) {
    log.warn('режим розыгрыша: simulateBots выключен — боты стали бы участниками с шансом на приз');
    cfg.game.simulateBots = 0;
  }
  if (!cfg.twitch.channel) cfg.twitch.enabled = false;
  // With the relay the channel comes from the link flow, so none is configured here.
  if (!cfg.kick.channel && cfg.kick.transport !== 'relay') cfg.kick.enabled = false;
  return cfg;
}

/* Browser-safe view of the config — strips every credential. */
export function publicConfig(cfg) {
  return {
    game: cfg.game,
    commands: cfg.commands,
    replies: cfg.replies,
    giveaway: { enabled: !!cfg.giveaway.enabled },
    twitch: { enabled: cfg.twitch.enabled, channel: cfg.twitch.channel, transport: cfg.twitch.transport },
    kick: { enabled: cfg.kick.enabled, channel: cfg.kick.channel, transport: cfg.kick.transport },
  };
}
