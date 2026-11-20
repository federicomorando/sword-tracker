// Limitatori in memoria: token bucket per chiave e contatore di connessioni.

export class RateLimiter {
  /** @param rate token/secondo, @param burst capienza massima */
  constructor(rate, burst, now = () => Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map(); // key -> { tokens, last }
  }

  take(key, cost = 1) {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.rate);
    b.last = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    return ok;
  }

  /** Elimina i bucket tornati pieni (nessuna informazione utile da tenere). */
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.last) / 1000) * this.rate >= this.burst) this.buckets.delete(k);
    }
  }
}

export class ConnectionCounter {
  constructor(max) {
    this.max = max;
    this.counts = new Map();
  }

  acquire(key) {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key) {
    const n = (this.counts.get(key) ?? 1) - 1;
    if (n <= 0) this.counts.delete(key);
    else this.counts.set(key, n);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * IP del client. Dietro il tunnel Cloudflare la connessione arriva da localhost
 * e l'IP reale è in CF-Connecting-IP: lo si legge solo se la connessione è
 * loopback (il server ascolta solo su 127.0.0.1, quindi può arrivare solo da cloudflared).
 */
export function clientIp(req) {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (LOOPBACK.has(remote)) {
    const h = req.headers['cf-connecting-ip'];
    if (typeof h === 'string' && h.length <= 64) return h.trim();
  }
  return remote;
}

/** Vero se l'Origin è assente (client non-browser) o ha lo stesso host della richiesta / è tra quelli ammessi. */
export function originAllowed(req, allowed = []) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  return host === req.headers.host || allowed.includes(origin);
}
