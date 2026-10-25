/* Tiny leveled logger with an in-memory ring buffer the control panel can read. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ring = [];
const RING_MAX = 300;
const subs = new Set();

let threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

const COL = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function write(level, scope, msg, extra) {
  const rec = { at: Date.now(), level, scope, msg: String(msg), extra: extra ?? null };
  ring.push(rec);
  if (ring.length > RING_MAX) ring.shift();
  for (const fn of subs) { try { fn(rec); } catch {} }
  if (LEVELS[level] < threshold) return;
  const t = new Date(rec.at).toTimeString().slice(0, 8);
  const tail = extra === undefined || extra === null ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  console.log(`${COL[level]}${t} ${level.padEnd(5)} ${scope.padEnd(7)}\x1b[0m ${msg}${tail}`);
}

export function logger(scope) {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
export function recent(n = 80) { return ring.slice(-n); }
export function onLog(fn) { subs.add(fn); return () => subs.delete(fn); }
export function setLevel(l) { if (LEVELS[l]) threshold = LEVELS[l]; }
