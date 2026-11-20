import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createStore, normalizeSlug, OpError } from '../server/boards.js';

const fresh = () => {
  let t = 1000;
  const store = createStore(openDb(':memory:'), () => t);
  store.getOrCreate('b');
  return { store, tick: (ms) => { t += ms; } };
};
const names = (state, slot) => state.tokens.filter((x) => x.slot === slot).map((x) => x.name);

test('slug: normalizzazione e rifiuto', () => {
  assert.equal(normalizeSlug('Nome-Mio-Tracker'), 'nome-mio-tracker');
  assert.equal(normalizeSlug('../etc'), null);
  assert.equal(normalizeSlug(''), null);
  assert.equal(normalizeSlug('a'.repeat(65)), null);
});

test('board nuova: intervallo -1..15', () => {
  const { store } = fresh();
  const s = store.getState('b');
  assert.equal(s.minSlot, -1);
  assert.equal(s.maxSlot, 15);
});

test('create + ordine di inserimento nello slot', () => {
  const { store } = fresh();
  store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 5 });
  const s = store.apply('b', { type: 'create', name: 'B', kind: 'monster', slot: 5 });
  assert.deepEqual(names(s, 5), ['A', 'B']);
  assert.equal(s.tokens[1].color, '#dc2626');
});

test('move: tra slot e riordino con indice', () => {
  const { store } = fresh();
  store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 5 });
  store.apply('b', { type: 'create', name: 'B', kind: 'player', slot: 5 });
  let s = store.apply('b', { type: 'create', name: 'C', kind: 'player', slot: 5 });
  const id = (n) => s.tokens.find((x) => x.name === n).id;
  s = store.apply('b', { type: 'move', id: id('C'), slot: 5, index: 0 });
  assert.deepEqual(names(s, 5), ['C', 'A', 'B']);
  s = store.apply('b', { type: 'move', id: id('A'), slot: 7, index: 0 });
  assert.deepEqual(names(s, 5), ['C', 'B']);
  assert.deepEqual(names(s, 7), ['A']);
  s = store.apply('b', { type: 'move', id: id('B'), slot: 7 });
  assert.deepEqual(names(s, 7), ['A', 'B']);
});

test('move fuori intervallo viene rifiutata', () => {
  const { store } = fresh();
  const s = store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 0 });
  assert.throws(() => store.apply('b', { type: 'move', id: s.tokens[0].id, slot: 16 }), OpError);
});

test('update e delete', () => {
  const { store } = fresh();
  let s = store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 0 });
  const id = s.tokens[0].id;
  s = store.apply('b', { type: 'update', id, name: 'Zed', playerName: 'Fede', color: '#112233' });
  assert.equal(s.tokens[0].name, 'Zed');
  assert.equal(s.tokens[0].playerName, 'Fede');
  assert.equal(s.tokens[0].color, '#112233');
  s = store.apply('b', { type: 'delete', id });
  assert.equal(s.tokens.length, 0);
});

test('config: restringere sposta le targhette sullo slot di confine', () => {
  const { store } = fresh();
  store.apply('b', { type: 'create', name: 'Alto', kind: 'player', slot: 15 });
  store.apply('b', { type: 'create', name: 'Basso', kind: 'player', slot: -1 });
  const s = store.apply('b', { type: 'config', minSlot: 0, maxSlot: 10 });
  assert.equal(s.tokens.find((x) => x.name === 'Alto').slot, 10);
  assert.equal(s.tokens.find((x) => x.name === 'Basso').slot, 0);
});

test('config: valori non validi', () => {
  const { store } = fresh();
  assert.throws(() => store.apply('b', { type: 'config', minSlot: 5, maxSlot: 5 }), OpError);
  assert.throws(() => store.apply('b', { type: 'config', minSlot: 0, maxSlot: 500 }), OpError);
  assert.throws(() => store.apply('b', { type: 'config', minSlot: 'a', maxSlot: 5 }), OpError);
});

test('operazioni non valide', () => {
  const { store } = fresh();
  assert.throws(() => store.apply('b', { type: 'nope' }), OpError);
  assert.throws(() => store.apply('b', { type: 'create', name: '  ', kind: 'player' }), OpError);
  assert.throws(() => store.apply('b', { type: 'create', name: 'X', kind: 'dragon' }), OpError);
  assert.throws(() => store.apply('b', { type: 'create', name: 'X', kind: 'player', color: 'red' }), OpError);
  assert.throws(() => store.apply('b', { type: 'constructor' }), OpError);
});

test('limite di targhette', () => {
  const { store } = fresh();
  for (let i = 0; i < 200; i++) store.apply('b', { type: 'create', name: `t${i}`, kind: 'monster', slot: 0 });
  assert.throws(() => store.apply('b', { type: 'create', name: 'extra', kind: 'monster', slot: 0 }), OpError);
});

test('scadenza board inattive', () => {
  const { store, tick } = fresh();
  store.getOrCreate('vecchia');
  tick(10_000);
  store.touch('b');
  assert.equal(store.deleteExpired(5_000), 1);
  assert.ok(store.getState('b'));
  assert.equal(store.getState('vecchia'), null);
});

test('acted: parte a false, si alterna con update e non tocca gli altri campi', () => {
  const { store } = fresh();
  let s = store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 3 });
  const id = s.tokens[0].id;
  assert.equal(s.tokens[0].acted, false);
  s = store.apply('b', { type: 'update', id, acted: true });
  assert.equal(s.tokens[0].acted, true);
  assert.equal(s.tokens[0].name, 'A');
  s = store.apply('b', { type: 'update', id, name: 'B' }); // rinominare non azzera la spunta
  assert.equal(s.tokens[0].acted, true);
  s = store.apply('b', { type: 'update', id, acted: false });
  assert.equal(s.tokens[0].acted, false);
  assert.throws(() => store.apply('b', { type: 'update', id, acted: 'si' }), OpError);
});

test('acted sopravvive agli spostamenti su e giù', () => {
  const { store } = fresh();
  let s = store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 3 });
  const id = s.tokens[0].id;
  store.apply('b', { type: 'update', id, acted: true });
  s = store.apply('b', { type: 'move', id, slot: 8, index: 0 });
  s = store.apply('b', { type: 'move', id, slot: 1 });
  assert.equal(s.tokens[0].acted, true);
  assert.equal(s.tokens[0].slot, 1);
});

test('resetTurn azzera le spunte solo della board indicata', () => {
  const { store } = fresh();
  store.getOrCreate('altra');
  for (const slug of ['b', 'altra']) {
    for (const n of ['A', 'B']) {
      const s = store.apply(slug, { type: 'create', name: n, kind: 'monster', slot: 2 });
      store.apply(slug, { type: 'update', id: s.tokens.find((t) => t.name === n).id, acted: true });
    }
  }
  const s = store.apply('b', { type: 'resetTurn' });
  assert.ok(s.tokens.every((t) => t.acted === false));
  assert.ok(store.getState('altra').tokens.every((t) => t.acted === true));
});

test('migrazione: un database senza la colonna acted viene aggiornato senza perdere dati', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { initSchema } = await import('../server/db.js');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE boards (slug TEXT PRIMARY KEY, min_slot INTEGER NOT NULL, max_slot INTEGER NOT NULL, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
    CREATE TABLE tokens (id TEXT PRIMARY KEY, board_slug TEXT NOT NULL REFERENCES boards(slug) ON DELETE CASCADE, name TEXT NOT NULL, player_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, color TEXT NOT NULL, slot INTEGER NOT NULL, position INTEGER NOT NULL);
    INSERT INTO boards VALUES ('vecchia', -1, 15, 1, 1);
    INSERT INTO tokens VALUES ('t1', 'vecchia', 'Elfo', '', 'player', '#3b82f6', 4, 0);
  `);
  initSchema(db);
  initSchema(db); // idempotente
  const store = createStore(db);
  const s = store.getState('vecchia');
  assert.equal(s.tokens[0].name, 'Elfo');
  assert.equal(s.tokens[0].acted, false);
  assert.equal(store.apply('vecchia', { type: 'update', id: 't1', acted: true }).tokens[0].acted, true);
});

test('deleteBoard elimina la board e le sue targhette, non le altre board', () => {
  const { store } = fresh();
  store.getOrCreate('altra');
  store.apply('b', { type: 'create', name: 'A', kind: 'player', slot: 1 });
  store.apply('altra', { type: 'create', name: 'Z', kind: 'player', slot: 1 });
  assert.equal(store.deleteBoard('b'), true);
  assert.equal(store.getState('b'), null);
  assert.equal(store.getState('altra').tokens.length, 1);
  assert.equal(store.deleteBoard('b'), false); // già eliminata
  // ricreata con lo stesso nome: vuota
  store.getOrCreate('b');
  assert.equal(store.getState('b').tokens.length, 0);
});
