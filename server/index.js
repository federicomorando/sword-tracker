import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { openDb } from './db.js';
import { createStore, normalizeSlug, OpError } from './boards.js';
import { RateLimiter, ConnectionCounter, clientIp, originAllowed } from './limits.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DB_PATH = process.env.DB_PATH ?? path.resolve('data/tracker.db');
const TTL_DAYS = Number(process.env.BOARD_TTL_DAYS ?? 365);
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const STATIC = new Set(['app.js', 'style.css', 'favicon.svg']);

export function createApp({ dbPath = DB_PATH, ttlDays = TTL_DAYS } = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const store = createStore(openDb(dbPath));
  const rooms = new Map(); // slug -> Set<ws>
  const conns = new ConnectionCounter(Number(process.env.MAX_CONN_PER_IP ?? 20));
  const newBoards = new RateLimiter(10 / 3600, 10); // 10 board nuove/ora per IP
  const ipOps = new RateLimiter(20, 60); // 20 op/s per IP, burst 60

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const name = url.pathname.replace(/^\//, '');
      let file = null;
      if (STATIC.has(name)) file = name;
      else if (name === '' || normalizeSlug(name.replace(/\/$/, ''))) file = 'index.html';
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Non trovato');
        return;
      }
      const body = await readFile(path.join(CLIENT_DIR, file));
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      }).end(body);
    } catch {
      res.writeHead(500).end('Errore');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const slug = url.pathname === '/ws' ? normalizeSlug(url.searchParams.get('board')) : null;
    if (!slug) {
      socket.destroy();
      return;
    }
    if (!originAllowed(req, ALLOWED_ORIGINS)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, slug, ip));
  });

  function broadcast(slug, state) {
    const msg = JSON.stringify({ type: 'state', state });
    for (const c of rooms.get(slug) ?? []) if (c.readyState === 1) c.send(msg);
  }

  function onConnection(ws, slug, ip) {
    if (!conns.acquire(ip)) {
      ws.close(1008, 'troppe connessioni da questo indirizzo');
      return;
    }
    ws.on('close', () => conns.release(ip));
    const created = !store.exists(slug);
    if (created && !newBoards.take(ip)) {
      ws.close(1008, 'troppe board create da questo indirizzo, riprova più tardi');
      return;
    }
    store.getOrCreate(slug);
    store.touch(slug);
    if (!rooms.has(slug)) rooms.set(slug, new Set());
    rooms.get(slug).add(ws);
    ws.send(JSON.stringify({ type: 'state', state: store.getState(slug) }));
    // rate limit: token bucket, 10 op/s a regime, burst 30
    let tokens = 30;
    let last = Date.now();
    ws.on('message', (data) => {
      const t = Date.now();
      tokens = Math.min(30, tokens + ((t - last) / 1000) * 10);
      last = t;
      if (tokens < 1 || !ipOps.take(ip)) {
        ws.send(JSON.stringify({ type: 'error', message: 'troppe operazioni, rallenta' }));
        return;
      }
      tokens = Math.max(0, tokens - 1);
      try {
        const op = JSON.parse(data.toString());
        if (op?.type === 'deleteBoard') {
          if (!store.deleteBoard(slug)) throw new OpError('board inesistente');
          const room = rooms.get(slug);
          rooms.delete(slug);
          for (const c of room ?? []) {
            if (c.readyState === 1) { c.send(JSON.stringify({ type: 'deleted' })); c.close(1000, 'board eliminata'); }
          }
          return;
        }
        broadcast(slug, store.apply(slug, op));
      } catch (e) {
        const message = e instanceof OpError ? e.message : 'messaggio non valido';
        ws.send(JSON.stringify({ type: 'error', message }));
        // riallinea il client allo stato reale
        ws.send(JSON.stringify({ type: 'state', state: store.getState(slug) }));
      }
    });
    ws.on('close', () => {
      const room = rooms.get(slug);
      room?.delete(ws);
      if (room?.size === 0) rooms.delete(slug);
    });
    ws.on('error', () => ws.terminate());
  }

  const ttlMs = ttlDays * 24 * 3600 * 1000;
  const cleanup = () => { store.deleteExpired(ttlMs); newBoards.sweep(); ipOps.sweep(); };
  cleanup();
  const timer = setInterval(cleanup, 24 * 3600 * 1000);
  timer.unref();

  return { server, store, close: () => { clearInterval(timer); wss.close(); server.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApp();
  server.listen(PORT, HOST, () => console.log(`SwORD tracker in ascolto su ${HOST}:${PORT}`));
}
