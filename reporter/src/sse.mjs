// Minimal SSE server hub and a reconnecting SSE client (Node 22 fetch, no deps).

export class SseHub {
  constructor() {
    this.clients = new Set();
    this.pinger = setInterval(() => this.#write(': ping\n\n'), 10000);
    this.pinger.unref?.();
  }

  /** Attach an incoming HTTP request as an SSE subscriber. */
  handle(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n: connected\n\n');
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('error', drop);
  }

  send(event) {
    this.#write(`data: ${JSON.stringify(event)}\n\n`);
  }

  #write(chunk) {
    for (const res of this.clients) {
      try {
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this.pinger);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
  }
}

/**
 * Subscribe to an SSE endpoint forever; reconnects with backoff.
 * Accepts standard "data: {json}" frames and bare one-line JSON.
 * @returns {{ status: object, stop: () => void }}
 */
export function subscribeSse(url, onEvent, { log = console.log, minBackoffMs = 500, maxBackoffMs = 3000 } = {}) {
  const status = { url, connected: false, lastEventTs: null, events: 0, errors: 0 };
  let stopped = false;
  let ctrl = null;
  let backoff = minBackoffMs;
  let warned = false;

  const deliver = (raw) => {
    const s = raw.trim();
    if (!s || s === '[DONE]') return;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      return;
    }
    status.events++;
    status.lastEventTs = Date.now();
    try {
      onEvent(ev, url);
    } catch (e) {
      log(`[reporter] handler error for ${url}: ${e.message}`);
    }
  };

  const loop = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        status.connected = true;
        backoff = minBackoffMs;
        if (warned) log(`[reporter] SSE reconnected: ${url}`);
        else log(`[reporter] SSE connected: ${url}`);
        warned = false;
        const decoder = new TextDecoder();
        let buf = '';
        let data = [];
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (line === '') {
              if (data.length) deliver(data.join('\n'));
              data = [];
            } else if (line.startsWith('data:')) {
              data.push(line.slice(5).replace(/^ /, ''));
            } else if (line.startsWith('{')) {
              deliver(line); // bare JSON line
            }
            // ignore comments (":"), event:, id:, retry:
          }
        }
        throw new Error('stream ended');
      } catch (e) {
        status.connected = false;
        if (stopped) break;
        status.errors++;
        if (!warned) {
          log(`[reporter] SSE unavailable: ${url} (${e.cause?.code ?? e.message}); retrying in background`);
          warned = true;
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(maxBackoffMs, backoff * 2);
      }
    }
  };
  loop();
  return {
    status,
    stop() {
      stopped = true;
      ctrl?.abort();
    },
  };
}
