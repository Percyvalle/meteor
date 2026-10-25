/* Hub: the host -> browser fan-out, over Server-Sent Events.
   Traffic is low-rate (joins and commands), so SSE beats a WebSocket here: the
   browser reconnects by itself and the host needs no WebSocket dependency. */
import { logger } from './log.mjs';

const log = logger('hub');

export class Hub {
  constructor() {
    this.clients = new Set();   // { res, role, id }
    this.nextId = 1;
  }

  attach(res, role, hello) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const client = { res, role, id: this.nextId++ };
    this.clients.add(client);
    res.write(': connected\n\n');
    this.to(client, hello);
    log.info(`${role} connected (${this.count(role)} ${role} client(s))`);

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
    const drop = () => {
      clearInterval(ping);
      if (this.clients.delete(client)) log.info(`${role} disconnected`);
    };
    res.on('close', drop);
    res.on('error', drop);
    return client;
  }

  count(role) { let n = 0; for (const c of this.clients) if (!role || c.role === role) n++; return n; }

  to(client, msg) {
    if (!msg) return;
    try { client.res.write(`data: ${JSON.stringify(msg)}\n\n`); }
    catch (e) { this.clients.delete(client); }
  }

  /* role: undefined = everyone */
  send(msg, role) {
    for (const c of this.clients) if (!role || c.role === role) this.to(c, msg);
  }
}
