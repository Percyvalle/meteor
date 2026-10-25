/* Token storage. Lives in .tokens.json next to the server, is gitignored, and is
   never exposed through the HTTP API. */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config.mjs';
import { logger } from '../log.mjs';

const log = logger('tokens');
const FILE = resolve(ROOT, '.tokens.json');

let cache = null;

function read() {
  if (cache) return cache;
  if (!existsSync(FILE)) return (cache = {});
  try { cache = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch (e) { log.warn(`.tokens.json unreadable (${e.message}) — starting empty`); cache = {}; }
  return cache;
}

function flush() {
  writeFileSync(FILE, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch {}
}

export function getTokens(platform) { return read()[platform] || null; }

export function setTokens(platform, t) {
  read();
  cache[platform] = { ...t, savedAt: Date.now() };
  flush();
  log.info(`${platform}: tokens saved`);
}

export function clearTokens(platform) {
  read();
  delete cache[platform];
  flush();
}

export function hasTokens(platform) { return !!getTokens(platform); }
