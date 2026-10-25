/* Shared adapter skeleton: a reconnect state machine with visible status.
   Errors are always surfaced (status + log) — never swallowed. */
import { logger } from '../log.mjs';

export class Adapter {
  constructor(platform, { cfg, bus }) {
    this.platform = platform;
    this.cfg = cfg;
    this.bus = bus;
    this.log = logger(platform);
    this.status = 'off';       // off | connecting | connected | reconnecting | error
    this.detail = '';
    this.attempt = 0;
    this.stopped = false;
    this.writable = false;     // can we post messages back to this chat?
    this.onStatus = null;
  }

  setStatus(status, detail) {
    if (this.status === status && this.detail === (detail || '')) return;
    this.status = status; this.detail = detail || '';
    this.log[status === 'error' ? 'error' : 'info'](`${status}${detail ? ' — ' + detail : ''}`);
    this.onStatus && this.onStatus(this);
  }

  backoff() {
    this.attempt = Math.min(this.attempt + 1, 6);
    return Math.round((500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5));
  }

  /* A failure the streamer must fix (bad key, blocked lookup, missing auth).
     Retrying cannot help, so stop and leave actionable text on the status. */
  fatal(msg) {
    this.stopped = true;
    clearTimeout(this._t);
    this.setStatus('error', msg);
  }

  scheduleReconnect(why) {
    if (this.stopped) return;
    const wait = this.backoff();
    this.setStatus('reconnecting', `${why} — retry in ${Math.round(wait / 1000)}s`);
    clearTimeout(this._t);
    this._t = setTimeout(() => this.connect().catch(e => this.scheduleReconnect(e.message)), wait);
  }

  emit(msg) { this.bus.push({ platform: this.platform, ...msg }); }

  canSay() { return this.writable && this.status === 'connected'; }

  stop() {
    this.stopped = true;
    clearTimeout(this._t);
    this.setStatus('off');
  }

  info() {
    return { platform: this.platform, status: this.status, detail: this.detail, writable: this.writable };
  }
}
