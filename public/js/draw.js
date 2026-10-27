/* Правило розыгрыша: как из состава и публичной случайности получается сид.
   Один и тот же файл исполняют хост (Node) и страница проверки (браузер),
   поэтому здесь только Web Crypto и fetch — ни DOM, ни node:*. */

export const RULE = 'meteor-v1';

/* drand quicknet: League of Entropy выпускает раунд каждые 3 секунды, и до
   выпуска его значение не знает никто. randomness = sha256(signature). */
export const DRAND = {
  chain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  genesis: 1692803367,
  period: 3,
  mirrors: ['https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com'],
};

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(String(s).match(/../g).map(h => parseInt(h, 16)));

export async function sha256hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/* Каноничный состав: по ключу, с итоговым островом. Ник в хэш не входит —
   его можно сменить, а ключ (платформа:числовой id) нет. */
export function canonRoster(list) {
  return list
    .map(p => [String(p.key ?? p[0]), String(p.name ?? p.display ?? p[1]), (p.island ?? p[2]) | 0])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function rosterHash(roster) {
  return sha256hex(JSON.stringify(roster.map(([key, , island]) => [key, island])));
}

export async function drawSeed({ draw, layout, winners, rosterHash, randomness }) {
  const h = await sha256hex([RULE, draw, layout, winners, rosterHash, randomness].join('|'));
  return { seedHex: h, seed: parseInt(h.slice(0, 8), 16) >>> 0 };
}

export function roundAt(ms) {
  return Math.floor((ms / 1000 - DRAND.genesis) / DRAND.period) + 1;
}
export function roundTime(round) {
  return (DRAND.genesis + (round - 1) * DRAND.period) * 1000;
}

/* Раунд с первого ответившего зеркала. Подпись сверяется с randomness —
   зеркало не может подсунуть случайность, не подходящую к подписи. */
export async function fetchRound(round, { mirrors = DRAND.mirrors, timeoutMs = 4000 } = {}) {
  let last = null;
  for (const base of mirrors) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(`${base}/${DRAND.chain}/public/${round}`, { signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) { last = new Error(`${base}: http ${r.status}`); continue; }
      const j = await r.json();
      if (j.round !== round) { last = new Error(`${base}: прислан раунд ${j.round}`); continue; }
      if (await sha256hex(unhex(j.signature)) !== j.randomness) { last = new Error(`${base}: randomness не сходится с подписью`); continue; }
      return { round: j.round, randomness: j.randomness, signature: j.signature };
    } catch (e) { last = e; }
  }
  throw last || new Error('drand недоступен');
}
