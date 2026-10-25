/* Live agent connections: streamers' local hosts, each holding one SSE stream.

   The relay never connects out to an agent — agents dial in, which is what makes
   this work behind NAT, firewalls and corporate proxies without any setup on the
   streamer's side. */
import { logger } from '../server/log.mjs';

const log = logger('agents');

export class AgentHub {
  constructor() {
    this.live = new Map();     // agentId -> { res, since, ping }
  }

  attach(agentId, res, hello) {
    this.drop(agentId, 'replaced by a new connection');

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const conn = { res, since: Date.now() };
    this.live.set(agentId, conn);
    this.send(agentId, hello);
    log.info(`${agentId} connected (${this.live.size} online)`);

    // Proxies and load balancers cut idle streams; a comment every 15s keeps it warm.
    conn.ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);

    const gone = () => {
      if (this.live.get(agentId) === conn) {
        clearInterval(conn.ping);
        this.live.delete(agentId);
        log.info(`${agentId} disconnected (${this.live.size} online)`);
      }
    };
    res.on('close', gone);
    res.on('error', gone);
  }

  drop(agentId, why) {
    const conn = this.live.get(agentId);
    if (!conn) return;
    clearInterval(conn.ping);
    this.live.delete(agentId);
    try { conn.res.end(); } catch {}
    log.info(`${agentId} dropped: ${why}`);
  }

  online(agentId) { return this.live.has(agentId); }
  count() { return this.live.size; }

  send(agentId, msg) {
    const conn = this.live.get(agentId);
    if (!conn || !msg) return false;
    try {
      conn.res.write(`data: ${JSON.stringify(msg)}\n\n`);
      return true;
    } catch {
      this.drop(agentId, 'write failed');
      return false;
    }
  }
}
