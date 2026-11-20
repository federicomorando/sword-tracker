import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../server/index.js';

const open = (port, board) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  ws.on('open', () => resolve({
    ws,
    next: async (pred) => {
      for (;;) {
        const i = msgs.findIndex(pred);
        if (i >= 0) return msgs.splice(i, 1)[0];
        await new Promise((r) => waiters.push(r));
      }
    },
  }));
  ws.on('error', reject);
});

test('due client sulla stessa board vedono le stesse modifiche', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const a = await open(port, 'sessione-1');
    const b = await open(port, 'sessione-1');
    await a.next((m) => m.type === 'state');
    await b.next((m) => m.type === 'state');
    a.ws.send(JSON.stringify({ type: 'create', name: 'Goblin', kind: 'monster', slot: 3 }));
    const seen = await b.next((m) => m.type === 'state' && m.state.tokens.length === 1);
    assert.equal(seen.state.tokens[0].name, 'Goblin');
    assert.equal(seen.state.tokens[0].slot, 3);

    // una board diversa non vede nulla
    const c = await open(port, 'altra');
    const other = await c.next((m) => m.type === 'state');
    assert.equal(other.state.tokens.length, 0);

    // operazione invalida: errore solo a chi l'ha inviata
    a.ws.send(JSON.stringify({ type: 'move', id: 'x', slot: 1 }));
    const err = await a.next((m) => m.type === 'error');
    assert.match(err.message, /inesistente/);
    for (const x of [a, b, c]) x.ws.close();
  } finally {
    app.close();
  }
});

test('HTTP: pagina servita su / e /<slug>, 404 altrove', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mio-tracker`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/..%2fpackage.json`)).status, 404);
  } finally {
    app.close();
  }
});

const tryOpen = (port, board, headers = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?board=${board}`, { headers });
  ws.on('open', () => resolve({ ws }));
  ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
  ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  ws.on('error', () => {});
});

test('WebSocket da Origin diverso viene rifiutato (403)', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const bad = await tryOpen(port, 'x', { Origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    const good = await tryOpen(port, 'x', { Origin: `http://127.0.0.1:${port}` });
    assert.ok(good.ws);
    good.ws.close();
  } finally {
    app.close();
  }
});

test('limite di board nuove per IP (CF-Connecting-IP)', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const h = { 'CF-Connecting-IP': '203.0.113.7' };
    for (let i = 0; i < 10; i++) {
      const c = await tryOpen(port, `b${i}`, h);
      assert.ok(c.ws, `board ${i} deve aprirsi`);
      c.ws.close();
    }
    const over = await tryOpen(port, 'b-extra', h);
    const closed = await new Promise((r) => over.ws.on('close', (code) => r(code)));
    assert.equal(closed, 1008);
    // un altro IP non è toccato; una board esistente resta accessibile
    const other = await tryOpen(port, 'b-extra', { 'CF-Connecting-IP': '203.0.113.8' });
    assert.ok(other.ws);
    other.ws.close();
    const existing = await tryOpen(port, 'b0', h);
    assert.ok(existing.ws);
    existing.ws.close();
  } finally {
    app.close();
  }
});

test('risposte HTTP con header di sicurezza', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    app.close();
  }
});

test('spunta e reset turn si propagano agli altri client', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const a = await open(port, 'turno');
    const b = await open(port, 'turno');
    await a.next((m) => m.type === 'state');
    await b.next((m) => m.type === 'state');
    a.ws.send(JSON.stringify({ type: 'create', name: 'Elfo', kind: 'player', slot: 4 }));
    const created = await b.next((m) => m.type === 'state' && m.state.tokens.length === 1);
    a.ws.send(JSON.stringify({ type: 'update', id: created.state.tokens[0].id, acted: true }));
    const checked = await b.next((m) => m.type === 'state' && m.state.tokens[0]?.acted === true);
    assert.equal(checked.state.tokens[0].acted, true);
    b.ws.send(JSON.stringify({ type: 'resetTurn' }));
    const reset = await a.next((m) => m.type === 'state' && m.state.tokens[0]?.acted === false);
    assert.equal(reset.state.tokens[0].acted, false);
    for (const x of [a, b]) x.ws.close();
  } finally {
    app.close();
  }
});

test('eliminazione della board: tutti i collegati vengono avvisati e la board riparte vuota', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, r));
  const { port } = app.server.address();
  try {
    const a = await open(port, 'da-eliminare');
    const b = await open(port, 'da-eliminare');
    await a.next((m) => m.type === 'state');
    await b.next((m) => m.type === 'state');
    a.ws.send(JSON.stringify({ type: 'create', name: 'Elfo', kind: 'player', slot: 2 }));
    await b.next((m) => m.type === 'state' && m.state.tokens.length === 1);

    b.ws.send(JSON.stringify({ type: 'deleteBoard' }));
    await a.next((m) => m.type === 'deleted');
    await b.next((m) => m.type === 'deleted');

    const c = await open(port, 'da-eliminare');
    assert.equal((await c.next((m) => m.type === 'state')).state.tokens.length, 0);
    c.ws.close();
  } finally {
    app.close();
  }
});
