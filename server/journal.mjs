/* Журнал розыгрышей: только дописывание, по строке JSON на событие.
   Запись «started» появляется в момент, когда сид уже определён, а исход ещё
   нет; потом к ней дописывается «completed» или «annulled». Розыгрыш, который
   так и остался «started», — это хост, упавший посреди матча, и это тоже видно. */
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from './config.mjs';
import { logger } from './log.mjs';

const log = logger('journal');

export class Journal {
  constructor(file) {
    this.path = resolve(ROOT, file || 'draws.jsonl');
    this.last = 0;
    this.records = new Map();
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.merge(JSON.parse(line)); } catch { log.warn('битая строка в журнале пропущена'); }
      }
    }
  }

  merge(rec) {
    if (!(rec.draw > 0)) return;
    this.last = Math.max(this.last, rec.draw);
    this.records.set(rec.draw, { ...(this.records.get(rec.draw) || {}), ...rec });
  }

  next() { return this.last + 1; }

  /* Номер занимается сразу, даже если розыгрыш потом не начнётся: пропуск в
     нумерации честнее, чем один номер на два разных состава. */
  reserve() { return ++this.last; }

  append(rec) {
    appendFileSync(this.path, JSON.stringify(rec) + '\n');
    this.merge(rec);
  }

  get(draw) { return this.records.get(draw) || null; }
}
