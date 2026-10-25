/* Transport to the local host: SSE down, POST up. No game knowledge lives here. */

export function connect(role, onMessage, onStatus) {
  let es = null, retry = 0, stopped = false;

  const open = () => {
    if (stopped) return;
    es = new EventSource(`/events?role=${encodeURIComponent(role)}`);
    es.onopen = () => { retry = 0; onStatus && onStatus('connected'); };
    es.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      onMessage(m);
    };
    es.onerror = () => {
      es.close();
      onStatus && onStatus('reconnecting');
      // EventSource reconnects on its own, but only for transport hiccups; a closed
      // stream (host restarted) needs a fresh object, with backoff so we don't spin.
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 250 * 2 ** retry);
    };
  };
  open();

  return { close() { stopped = true; es && es.close(); } };
}

export async function post(path, body) {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

export async function get(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
