/* Meteor relay — the one public component.

   It exists because Kick delivers chat by webhook to a single URL per app. The
   relay owns that app, receives every streamer's events, and routes each one to
   the right local host over a connection that host opened itself.

   Streamers configure nothing: their local host dials in, they click one link to
   authorize Kick, and the binding is remembered. A streamer who has no access to
   the channel account instead claims the channel by slug — the relay subscribes
   with its own app token, read-only. See /agent/claim.

   Run:  node relay/index.mjs        (config in relay.config.json or env) */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger, recent } from '../server/log.mjs';
import { AgentHub } from './agents.mjs';
import {
  ROOT, authAgent, getAgent, bindBroadcaster, agentForBroadcaster,
  setSubscription, unlink, publicAgent, allAgents,
  STATE_FILE,
} from './store.mjs';
import {
  kickPublicKey, verifySignature, beginAuth, exchangeCode, missingScopes,
  whoAmI, channelOf, subscribeChat, unsubscribe, sendChat, normalizeChat, broadcasterOf,
  resolveChannel, subscribeChatAsApp, unsubscribeAsApp,
} from './kick.mjs';

const log = logger('relay');

/* ---------- config ---------- */

function loadConfig() {
  let file = {};
  const p = resolve(ROOT, 'relay.config.json');
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { log.error(`relay.config.json is not valid JSON: ${e.message}`); process.exit(1); }
  }
  const cfg = {
    port: Number(process.env.RELAY_PORT || file.port || 8088),
    host: process.env.RELAY_HOST || file.host || '0.0.0.0',
    // The public origin this relay is reachable at, e.g. https://relay.example.com
    publicUrl: (process.env.RELAY_PUBLIC_URL || file.publicUrl || '').replace(/\/+$/, ''),
    clientId: process.env.KICK_CLIENT_ID || file.clientId || '',
    clientSecret: process.env.KICK_CLIENT_SECRET || file.clientSecret || '',
    sendAs: file.sendAs || 'bot',          // 'bot' needs a bot created for the app
  };
  cfg.redirectUri = `${cfg.publicUrl}/auth/kick/callback`;
  if (!cfg.publicUrl) { log.error('publicUrl is required — set it to the address Kick and agents will reach'); process.exit(1); }
  if (!cfg.clientId || !cfg.clientSecret) { log.error('clientId / clientSecret are required'); process.exit(1); }
  return cfg;
}

const cfg = loadConfig();
const hub = new AgentHub();

/* Pending OAuth flows and one-time link codes, both short-lived and in memory:
   losing them on restart only means the streamer clicks the link again. */
const pendingAuth = new Map();   // state -> { agentId, verifier, at }
const linkCodes = new Map();     // code -> { agentId, at }
const LINK_TTL = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuth) if (now - v.at > LINK_TTL) pendingAuth.delete(k);
  for (const [k, v] of linkCodes) if (now - v.at > LINK_TTL) linkCodes.delete(k);
}, 60000).unref();

/* ---------- http helpers ---------- */

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

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

const readJson = async req => {
  const raw = await readRaw(req, 64 * 1024);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
};

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function page(title, body, ok) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{background:#05070f;color:#eaf0ff;font:15px/1.6 Rubik,Segoe UI,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px}
.card{border:1px solid #1c2540;background:#0c1222;border-radius:14px;padding:28px 34px;max-width:62ch}
h1{font-size:19px;margin:0 0 10px;color:${ok ? '#7ff0c4' : '#ff7a2f'}}p{margin:8px 0 0;color:#8d97b8}</style>
<div class="card"><h1>${title}</h1><p>${body}</p></div>`;
}

/* ---------- agent authentication ---------- */

/* An agent proves itself with the id/key pair it generated on first run. */
function requireAgent(req) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('agent') || '';
  const key = bearer(req) || url.searchParams.get('key') || '';
  const a = authAgent(id, key);
  return a ? { agent: a, url } : { agent: null, url };
}

/* ---------- routes ---------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    /* --- Kick webhook: one URL for every streamer --- */
    if (req.method === 'POST' && p === '/webhooks/kick') {
      const raw = await readRaw(req);
      let key;
      try { key = await kickPublicKey(); }
      catch (e) { log.error(`cannot fetch Kick public key: ${e.message}`); return send(res, 503, 'text/plain', 'no key'); }

      const v = verifySignature(key, req.headers, raw);
      if (!v.ok) {
        log.warn(`rejected webhook: ${v.reason}`);
        return send(res, v.reason === 'stale timestamp' ? 400 : 403, 'text/plain', 'rejected');
      }

      if (seenRecently(v.id)) return send(res, 200, 'text/plain', 'duplicate');

      let e;
      try { e = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'text/plain', 'bad json'); }

      const type = req.headers['kick-event-type'];
      if (type && type !== 'chat.message.sent') return send(res, 200, 'text/plain', 'ignored');

      const bid = broadcasterOf(e);
      const agent = agentForBroadcaster(bid);
      if (!agent) {
        // Nobody is linked to this channel; acknowledging stops pointless retries.
        log.warn(`event for unlinked broadcaster ${bid}`);
        return send(res, 200, 'text/plain', 'unlinked');
      }

      const msg = normalizeChat(e, agent.channel);
      const delivered = hub.send(agent.id, { t: 'chat', msg });
      // Offline agent: the streamer's host is simply not running. Retrying will not
      // help within Kick's window, and the game cannot use a late message anyway.
      return send(res, 200, 'text/plain', delivered ? 'ok' : 'offline');
    }

    /* --- agent stream: the local host dials in and stays connected --- */
    if (req.method === 'GET' && p === '/agent/events') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });
      hub.attach(agent.id, res, { t: 'hello', agent: publicAgent(agent), relay: cfg.publicUrl });
      return;
    }

    /* --- agent asks for a link to show its streamer --- */
    if (req.method === 'POST' && p === '/agent/link') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });
      const code = randomBytes(16).toString('hex');
      linkCodes.set(code, { agentId: agent.id, at: Date.now() });
      return json(res, 200, { ok: true, url: `${cfg.publicUrl}/link/${code}`, expiresInMs: LINK_TTL });
    }

    /* --- agent claims a channel by slug, with no authorization from its owner ---

       Verified live: an app access token subscribes to chat.message.sent for any
       broadcaster_user_id. This is the path for a streamer who works on someone
       else's channel and cannot click through OAuth there. Read-only: posting to
       chat still needs the owner's token, so /agent/say stays closed in this mode. */
    if (req.method === 'POST' && p === '/agent/claim') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });

      const body = await readJson(req).catch(() => ({}));
      let ch;
      try { ch = await resolveChannel(cfg, body.slug); }
      catch (e) { return json(res, 400, { ok: false, error: e.message }); }

      // An owner-authorized binding is strictly better; never downgrade it silently.
      if (agent.tokens && Number(agent.broadcasterUserId) === ch.broadcasterUserId) {
        return json(res, 200, { ok: true, agent: publicAgent(agent), note: 'already linked via OAuth' });
      }

      try {
        // Переезд на другой канал: подписку на прежний надо снять, иначе Kick
        // продолжит слать по ней события, которые уже некому отдать.
        if (agent.subscriptionId && Number(agent.broadcasterUserId) !== ch.broadcasterUserId) {
          if (agent.tokens) await unsubscribe(cfg, agent, agent.subscriptionId);
          else await unsubscribeAsApp(cfg, agent.subscriptionId);
        }
        const bound = bindBroadcaster(agent.id, ch.broadcasterUserId, ch.slug, null, 'app');
        if (!bound) return json(res, 500, { ok: false, error: 'агент не найден' });
        const subId = await subscribeChatAsApp(cfg, ch.broadcasterUserId);
        setSubscription(bound.id, subId);
        log.info(`claimed ${ch.slug} (${ch.broadcasterUserId}) -> agent ${bound.id} [app token, read-only]`);
        const pub = publicAgent(getAgent(bound.id));
        hub.send(bound.id, { t: 'status', agent: pub });
        return json(res, 200, { ok: true, agent: pub });
      } catch (e) {
        log.error(`claim failed for ${ch.slug}: ${e.message}`);
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && p === '/agent/unlink') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });
      if (agent.subscriptionId) {
        if (agent.tokens) await unsubscribe(cfg, agent, agent.subscriptionId);
        else await unsubscribeAsApp(cfg, agent.subscriptionId);
      }
      unlink(agent.id);
      hub.send(agent.id, { t: 'status', agent: publicAgent(getAgent(agent.id)) });
      return json(res, 200, { ok: true });
    }

    /* --- agent sends a chat message through the streamer's own token --- */
    if (req.method === 'POST' && p === '/agent/say') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });
      if (!agent.tokens) {
        return json(res, 409, {
          ok: false,
          error: agent.mode === 'app'
            ? 'канал привязан без авторизации владельца — бот может только читать чат'
            : 'not linked',
        });
      }
      const body = await readJson(req);
      const text = String(body.text || '').slice(0, 400);
      if (!text) return json(res, 400, { ok: false, error: 'empty text' });
      try {
        await sendChat(cfg, agent, text, cfg.sendAs);
        return json(res, 200, { ok: true });
      } catch (e) {
        log.warn(`${agent.channel || agent.id}: chat send failed: ${e.message}`);
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (req.method === 'GET' && p === '/agent/status') {
      const { agent } = requireAgent(req);
      if (!agent) return json(res, 401, { ok: false, error: 'bad agent credentials' });
      return json(res, 200, { ok: true, agent: publicAgent(agent), online: hub.online(agent.id) });
    }

    /* --- the streamer opens this link and authorizes Kick --- */
    if (req.method === 'GET' && p.startsWith('/link/')) {
      const code = p.slice('/link/'.length);
      const entry = linkCodes.get(code);
      if (!entry || Date.now() - entry.at > LINK_TTL) {
        return send(res, 400, 'text/html; charset=utf-8',
          page('Ссылка устарела', 'Откройте панель хоста и нажмите «Подключить Kick» ещё раз.'));
      }
      linkCodes.delete(code);
      const state = randomBytes(16).toString('hex');
      const { url: authUrl, verifier } = beginAuth(cfg, state);
      pendingAuth.set(state, { agentId: entry.agentId, verifier, at: Date.now() });
      res.writeHead(302, { location: authUrl });
      return res.end();
    }

    if (req.method === 'GET' && p === '/auth/kick/callback') {
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const entry = state && pendingAuth.get(state);
      pendingAuth.delete(state);

      if (url.searchParams.get('error')) {
        return send(res, 400, 'text/html; charset=utf-8',
          page('Kick отклонил запрос', url.searchParams.get('error_description') || url.searchParams.get('error')));
      }
      if (!entry || !code) {
        return send(res, 400, 'text/html; charset=utf-8',
          page('Ссылка устарела', 'Нажмите «Подключить Kick» в панели ещё раз.'));
      }

      try {
        const tokens = await exchangeCode(cfg, code, entry.verifier);
        const missing = missingScopes(tokens);
        if (missing.length) {
          return send(res, 400, 'text/html; charset=utf-8', page('Не хватает разрешений',
            `Kick выдал не все права: не хватает <b>${missing.join(', ')}</b>. Это настраивается в приложении на стороне релея.`));
        }

        const probe = { id: entry.agentId, tokens, channel: '', broadcasterUserId: 0 };
        const me = await whoAmI(cfg, probe);
        const ch = await channelOf(cfg, probe);
        const bid = ch.broadcasterUserId || me.userId;
        if (!bid) throw new Error('не удалось определить канал');

        const agent = bindBroadcaster(entry.agentId, bid, ch.slug || me.name, tokens);
        if (!agent) throw new Error('агент не найден');

        const subId = await subscribeChat(cfg, agent, bid);
        setSubscription(agent.id, subId);
        log.info(`linked ${ch.slug || me.name} (${bid}) -> agent ${agent.id}`);

        hub.send(agent.id, { t: 'status', agent: publicAgent(getAgent(agent.id)) });
        return send(res, 200, 'text/html; charset=utf-8', page(
          'Kick подключён',
          `Канал <b>${ch.slug || me.name}</b> привязан. Можно закрыть вкладку и вернуться к игре.`, true));
      } catch (e) {
        log.error(`link failed: ${e.message}`);
        return send(res, 500, 'text/html; charset=utf-8', page('Не получилось подключить', e.message));
      }
    }

    /* --- operator view --- */
    if (req.method === 'GET' && (p === '/' || p === '/status')) {
      const agents = allAgents().map(a => ({ ...publicAgent(a), online: hub.online(a.id) }));
      if (p === '/status') return json(res, 200, { ok: true, online: hub.count(), agents, log: recent(40) });
      const label = a => !a.linked ? 'нет'
        : a.mode === 'app' ? 'привязан (только чтение)'
        : 'привязан';
      const rows = agents.map(a =>
        `<tr><td>${a.channel || '—'}</td><td>${label(a)}</td><td>${a.online ? 'онлайн' : 'офлайн'}</td></tr>`).join('');
      return send(res, 200, 'text/html; charset=utf-8', page('Meteor relay',
        `Подключено агентов: <b>${hub.count()}</b><table style="margin:14px auto;border-collapse:collapse">
         <tr><th style="padding:4px 12px">канал</th><th style="padding:4px 12px">Kick</th><th style="padding:4px 12px">хост</th></tr>
         ${rows || '<tr><td colspan=3>пока никого</td></tr>'}</table>`, true));
    }

    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    log.error(`${req.method} ${p}: ${e.message}`);
    json(res, 500, { ok: false, error: e.message });
  }
});

/* Kick retries deliveries; the same message must not be played twice. */
const seen = new Map();
function seenRecently(id) {
  const now = Date.now();
  if (seen.has(id)) return true;
  seen.set(id, now);
  if (seen.size > 5000) for (const [k, t] of seen) if (now - t > 10 * 60 * 1000) seen.delete(k);
  return false;
}

server.listen(cfg.port, cfg.host, () => {
  console.log('');
  log.info(`relay listening on ${cfg.host}:${cfg.port}`);
  log.info(`state file     ${STATE_FILE}`);
  log.info(`public url     ${cfg.publicUrl}`);
  log.info(`kick webhook   ${cfg.publicUrl}/webhooks/kick   <- впишите в приложение Kick`);
  log.info(`redirect uri   ${cfg.redirectUri}   <- и это тоже`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log.info('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000); });
}
