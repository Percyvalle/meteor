/* Local host for the Meteor Shower stream game.
   Wiring order: config -> hub -> outbox -> session -> bus -> router -> adapters.
   Binds to the loopback interface only; credentials never leave this process. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';
import { loadConfig, publicConfig, ROOT } from './config.mjs';
import { logger, recent, onLog } from './log.mjs';
import { Hub } from './hub.mjs';
import { Outbox } from './outbox.mjs';
import { Session } from './session.mjs';
import { ChatBus } from './bus.mjs';
import { CommandRouter } from './router.mjs';
import { TwitchAdapter } from './adapters/twitch.mjs';
import { KickAdapter } from './adapters/kick.mjs';
import { KickWebhookAdapter } from './adapters/kick-webhook.mjs';
import { RelayAdapter } from './adapters/relay.mjs';
import { hasTokens, clearTokens } from './oauth/store.mjs';
import { authorizeUrl, handleCallback } from './oauth/flows.mjs';

const log = logger('host');
const cfg = loadConfig();

const hub = new Hub();
const outbox = new Outbox({ cfg });
const session = new Session({ cfg, hub, outbox });
const bus = new ChatBus(cfg);
const router = new CommandRouter({ cfg, session, outbox });
bus.on('message', m => router.handle(m));

/* ---------- adapters ---------- */

const adapters = new Map();
function addAdapter(name, Klass) {
  const a = new Klass({ cfg, bus });
  a.onStatus = () => hub.send({ t: 'status', adapters: adapterInfo() }, 'control');
  adapters.set(name, a);
  outbox.register(name, a);
  a.connect().catch(e => a.scheduleReconnect(e.message));
}
if (cfg.twitch.enabled) addAdapter('twitch', TwitchAdapter);
if (cfg.kick.enabled) {
  const K = cfg.kick.transport === 'relay' ? RelayAdapter
    : cfg.kick.transport === 'webhook' ? KickWebhookAdapter
    : KickAdapter;
  addAdapter('kick', K);
}
if (!adapters.size) log.warn('no chat platform configured - use the control panel to inject test messages');

function adapterInfo() {
  const out = {};
  for (const [k, a] of adapters) out[k] = { ...a.info(), authorized: hasTokens(k) };
  for (const k of ['twitch', 'kick']) {
    if (!out[k]) out[k] = { platform: k, status: 'off', detail: cfg[k].channel ? 'disabled' : 'no channel configured', writable: false, authorized: hasTokens(k) };
  }
  return out;
}

/* ---------- static files ---------- */

const PUBLIC = resolve(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/control.html' : pathname;
  // normalize() collapses any ".." before we join, so the path cannot escape public/.
  const file = resolve(PUBLIC, '.' + normalize(rel).replace(/\\/g, '/'));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'forbidden');
  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    send(res, 404, 'text/plain', 'not found');
  }
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

/* Raw bytes, because a webhook signature is computed over the exact body. */
function readRaw(req, limit = 256 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0;
    const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { fail(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((ok, fail) => {
    let n = 0;
    const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { fail(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      if (!parts.length) return ok({});
      try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); }
      catch (e) { fail(new Error('invalid JSON body')); }
    });
    req.on('error', fail);
  });
}

/* ---------- http ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (req.method === 'GET' && p === '/events') {
      const role = url.searchParams.get('role') === 'overlay' ? 'overlay' : 'control';
      const hello = role === 'overlay'
        ? { t: 'hello', session: session.snapshot() }
        : { t: 'hello', session: session.publicSnapshot(), roster: session.rosterList(), adapters: adapterInfo(), config: publicConfig(cfg), log: recent(60) };
      hub.attach(res, role, hello);
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      return json(res, 200, {
        ok: true,
        session: session.publicSnapshot(),
        adapters: adapterInfo(),
        config: publicConfig(cfg),
        overlays: hub.count('overlay'),
        dropped: router.dropped,
        chatCounts: bus.counts,
      });
    }

    if (req.method === 'POST' && p === '/api/cmd') {
      const b = await readBody(req);
      switch (b.name) {
        // keep: re-roll the match but hold on to the players already in the lobby
        case 'start': session.start({ keepRoster: !!b.keep }); break;
        case 'go': session.go(); break;
        case 'reset': session.reset(false); break;
        case 'winners': session.setWinners(b.value); break;
        case 'say': if (b.platform) outbox.say(b.platform, String(b.value || '').slice(0, 400)); break;
        case 'reconnect': {
          const a = adapters.get(b.platform);
          if (a) { a.stopped = false; a.attempt = 0; a.connect().catch(e => a.scheduleReconnect(e.message)); }
          break;
        }
        /* Relay transport: hand the streamer a one-time link to authorize Kick. */
        case 'link': {
          const a = adapters.get(b.platform || 'kick');
          if (!a || typeof a.linkUrl !== 'function') return json(res, 400, { ok: false, error: 'this transport has no link flow' });
          try { return json(res, 200, { ok: true, url: await a.linkUrl() }); }
          catch (e) { return json(res, 502, { ok: false, error: e.message }); }
        }
        case 'unlink': {
          const a = adapters.get(b.platform || 'kick');
          if (a && typeof a.unlink === 'function') await a.unlink();
          break;
        }
        case 'logout': {
          clearTokens(b.platform);
          hub.send({ t: 'status', adapters: adapterInfo() }, 'control');
          break;
        }
        default: return json(res, 400, { ok: false, error: `unknown command "${b.name}"` });
      }
      return json(res, 200, { ok: true, session: session.publicSnapshot() });
    }

    /* Kick pushes chat here. The adapter verifies the signature itself; a non-200
       tells Kick to retry, so never answer 200 for something we failed to handle. */
    if (req.method === 'POST' && p === '/webhooks/kick') {
      const a = adapters.get('kick');
      if (!a || typeof a.receive !== 'function') return send(res, 404, 'text/plain', 'no kick webhook adapter');
      const raw = await readRaw(req);
      const status = a.receive(req.headers, raw);
      return send(res, status, 'text/plain', status === 200 ? 'ok' : 'rejected');
    }

    if (req.method === 'POST' && p === '/api/report') {
      const b = await readBody(req);
      session.report(b);
      return json(res, 200, { ok: true });
    }

    /* Synthetic chat message - lets the whole pipeline be tested with no live chat. */
    if (req.method === 'POST' && p === '/api/chat/inject') {
      const b = await readBody(req);
      bus.push({
        platform: b.platform || 'local',
        userId: b.userId || b.display || 'tester',
        display: b.display || 'tester',
        text: b.text || '',
        roles: b.roles || { broadcaster: true, mod: true },
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && (p === '/auth/twitch' || p === '/auth/kick')) {
      const platform = p.endsWith('twitch') ? 'twitch' : 'kick';
      try {
        res.writeHead(302, { location: authorizeUrl(cfg, platform) });
        res.end();
      } catch (e) {
        send(res, 400, 'text/html; charset=utf-8', page('Не получилось начать авторизацию', e.message));
      }
      return;
    }

    if (req.method === 'GET' && (p === '/auth/twitch/callback' || p === '/auth/kick/callback')) {
      const platform = p.includes('twitch') ? 'twitch' : 'kick';
      try {
        const who = await handleCallback(cfg, platform, url.searchParams);
        const a = adapters.get(platform);
        if (a) { a.stopped = false; a.attempt = 0; a.connect().catch(e => a.scheduleReconnect(e.message)); }
        hub.send({ t: 'status', adapters: adapterInfo() }, 'control');
        send(res, 200, 'text/html; charset=utf-8', page(`${platform} подключён`, `Аккаунт: ${who}. Можно закрыть вкладку.`, true));
      } catch (e) {
        log.error(`${platform} callback failed: ${e.message}`);
        send(res, 400, 'text/html; charset=utf-8', page(`${platform}: ошибка авторизации`, e.message));
      }
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    send(res, 405, 'text/plain', 'method not allowed');
  } catch (e) {
    log.error(`${req.method} ${p}: ${e.message}`);
    json(res, 500, { ok: false, error: e.message });
  }
});

function page(title, body, ok) {
  return `<title>${title}</title><meta charset="utf-8">
<style>body{background:#05070f;color:#eaf0ff;font:15px/1.6 Rubik,Segoe UI,Arial,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center}
.card{border:1px solid #1c2540;background:#0c1222;border-radius:14px;padding:28px 34px;max-width:60ch}
h1{font-size:19px;margin:0 0 10px;color:${ok ? '#7ff0c4' : '#ff7a2f'}}p{margin:0;color:#8d97b8}a{color:#ff7a2f}</style>
<div class="card"><h1>${title}</h1><p>${body}</p><p style="margin-top:14px"><a href="/">← к панели</a></p></div>`;
}

/* Stream the log into the control panel. */
onLog(rec => hub.send({ t: 'log', rec }, 'control'));

server.listen(cfg.port, cfg.host, () => {
  const base = `http://${cfg.host}:${cfg.port}`;
  if (cfg.kick.enabled && cfg.kick.transport === 'webhook') {
    const pub = cfg.kick.publicUrl ? cfg.kick.publicUrl.replace(/\/+$/, '') : '<адрес туннеля>';
    log.info(`kick webhook URL (впишите в приложение Kick): ${pub}/webhooks/kick`);
  }
  console.log('');
  log.info(`panel    ${base}/`);
  log.info(`overlay  ${base}/overlay.html?obs=1   <- OBS Browser Source, 1920x1080`);
  log.info(`channels twitch:${cfg.twitch.channel || '-'}  kick:${cfg.kick.channel || '-'}`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('shutting down');
    for (const a of adapters.values()) a.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
