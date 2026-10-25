/* Persistent state for the relay: one record per streamer.

   An agent is a streamer's local host. It owns a long-lived id/key pair it
   generated itself; the relay learns the key the first time it sees the id and
   refuses it afterwards from anyone else. Kick tokens are stored per broadcaster
   and never leave this process. */
import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* In a container the project directory is ephemeral, so the state file must be
   able to live on a mounted volume. RELAY_STATE_FILE points it anywhere. */
const FILE = process.env.RELAY_STATE_FILE
  ? resolve(process.env.RELAY_STATE_FILE)
  : resolve(ROOT, '.relay-state.json');

export const STATE_FILE = FILE;

let state = null;

function load() {
  if (state) return state;
  if (!existsSync(FILE)) return (state = { agents: {}, byBroadcaster: {} });
  try { state = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { state = { agents: {}, byBroadcaster: {} }; }
  state.agents ||= {};
  state.byBroadcaster ||= {};
  return state;
}

let flushTimer = null;
function flush() {
  // Batched: a burst of writes (token refresh + subscription + binding) is one save.
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    mkdirSync(dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, FILE);          // atomic: a crash mid-write cannot truncate the file
    try { chmodSync(FILE, 0o600); } catch {}
  }, 50);
}

const hashKey = key => createHash('sha256').update(String(key)).digest('hex');

/* Registers an agent on first sight, then authenticates it on every reconnect. */
export function authAgent(agentId, key) {
  const s = load();
  const id = String(agentId || '').trim();
  if (!/^[a-f0-9]{16,64}$/i.test(id) || !key || String(key).length < 32) return null;

  let a = s.agents[id];
  if (!a) {
    a = s.agents[id] = { id, keyHash: hashKey(key), createdAt: Date.now(), broadcasterUserId: 0, channel: '' };
    flush();
    return a;
  }
  const want = Buffer.from(a.keyHash, 'hex');
  const got = Buffer.from(hashKey(key), 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return a;
}

export function getAgent(agentId) { return load().agents[agentId] || null; }

/* Binds a Kick account to an agent. One broadcaster maps to exactly one agent:
   re-linking from a new machine moves the binding rather than duplicating it. */
export function bindBroadcaster(agentId, broadcasterUserId, channel, tokens) {
  const s = load();
  const a = s.agents[agentId];
  if (!a) return null;
  const bid = String(broadcasterUserId);

  const previous = s.byBroadcaster[bid];
  if (previous && previous !== agentId && s.agents[previous]) {
    s.agents[previous].broadcasterUserId = 0;
    s.agents[previous].channel = '';
  }

  a.broadcasterUserId = Number(broadcasterUserId);
  a.channel = channel || '';
  a.tokens = tokens;
  a.linkedAt = Date.now();
  s.byBroadcaster[bid] = agentId;
  flush();
  return a;
}

export function agentForBroadcaster(broadcasterUserId) {
  const s = load();
  const id = s.byBroadcaster[String(broadcasterUserId)];
  return id ? s.agents[id] || null : null;
}

export function setTokens(agentId, tokens) {
  const a = load().agents[agentId];
  if (!a) return;
  a.tokens = tokens;
  flush();
}

export function unlink(agentId) {
  const s = load();
  const a = s.agents[agentId];
  if (!a) return;
  if (a.broadcasterUserId) delete s.byBroadcaster[String(a.broadcasterUserId)];
  a.broadcasterUserId = 0;
  a.channel = '';
  delete a.tokens;
  delete a.subscriptionId;
  flush();
}

export function setSubscription(agentId, subscriptionId) {
  const a = load().agents[agentId];
  if (!a) return;
  a.subscriptionId = subscriptionId;
  flush();
}

/* Safe to log or expose: carries no tokens. */
export function publicAgent(a) {
  if (!a) return null;
  return {
    id: a.id,
    channel: a.channel || '',
    broadcasterUserId: a.broadcasterUserId || 0,
    linked: !!a.tokens,
    linkedAt: a.linkedAt || null,
    subscriptionId: a.subscriptionId || null,
  };
}

export function allAgents() { return Object.values(load().agents); }
