import { randomUUID } from 'node:crypto';

export const DEFAULT_MIN = -1;
export const DEFAULT_MAX = 15;
export const MAX_SPAN = 100; // numero massimo di slot
export const SLOT_LIMIT = 999;
export const MAX_TOKENS = 200;
export const KINDS = ['player', 'monster', 'ally'];
export const KIND_COLORS = { player: '#3b82f6', monster: '#dc2626', ally: '#16a34a' };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class OpError extends Error {}

export function normalizeSlug(raw) {
  const slug = String(raw ?? '').toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

const str = (v, max, what) => {
  if (typeof v !== 'string') throw new OpError(`${what} non valido`);
  const s = v.trim().slice(0, max);
  return s;
};
const int = (v, what) => {
  if (!Number.isInteger(v)) throw new OpError(`${what} non valido`);
  return v;
};
const color = (v) => {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new OpError('colore non valido');
  return v.toLowerCase();
};

export function createStore(db, now = () => Date.now()) {
  const q = {
    getBoard: db.prepare('SELECT * FROM boards WHERE slug = ?'),
    insertBoard: db.prepare('INSERT INTO boards (slug, min_slot, max_slot, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)'),
    touch: db.prepare('UPDATE boards SET last_active_at = ? WHERE slug = ?'),
    setRange: db.prepare('UPDATE boards SET min_slot = ?, max_slot = ? WHERE slug = ?'),
    tokens: db.prepare('SELECT id, name, player_name, kind, color, slot, position, acted FROM tokens WHERE board_slug = ? ORDER BY slot, position'),
    token: db.prepare('SELECT * FROM tokens WHERE id = ? AND board_slug = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE board_slug = ?'),
    slotTokens: db.prepare('SELECT id FROM tokens WHERE board_slug = ? AND slot = ? ORDER BY position'),
    insertToken: db.prepare('INSERT INTO tokens (id, board_slug, name, player_name, kind, color, slot, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    updateToken: db.prepare('UPDATE tokens SET name = ?, player_name = ?, kind = ?, color = ?, acted = ? WHERE id = ?'),
    resetActed: db.prepare('UPDATE tokens SET acted = 0 WHERE board_slug = ?'),
    placeToken: db.prepare('UPDATE tokens SET slot = ?, position = ? WHERE id = ?'),
    deleteToken: db.prepare('DELETE FROM tokens WHERE id = ?'),
    clampLow: db.prepare('UPDATE tokens SET slot = ? WHERE board_slug = ? AND slot < ?'),
    clampHigh: db.prepare('UPDATE tokens SET slot = ? WHERE board_slug = ? AND slot > ?'),
    slotTokensStable: db.prepare('SELECT id FROM tokens WHERE board_slug = ? AND slot = ? ORDER BY position, rowid'),
    slotsInUse: db.prepare('SELECT DISTINCT slot FROM tokens WHERE board_slug = ?'),
    deleteBoard: db.prepare('DELETE FROM boards WHERE slug = ?'),
    expired: db.prepare('DELETE FROM boards WHERE last_active_at < ?'),
  };

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function getOrCreate(slug) {
    let b = q.getBoard.get(slug);
    if (!b) {
      const t = now();
      q.insertBoard.run(slug, DEFAULT_MIN, DEFAULT_MAX, t, t);
      b = q.getBoard.get(slug);
    }
    return b;
  }

  function getState(slug) {
    const b = q.getBoard.get(slug);
    if (!b) return null;
    return {
      slug,
      minSlot: b.min_slot,
      maxSlot: b.max_slot,
      tokens: q.tokens.all(slug).map((t) => ({
        id: t.id, name: t.name, playerName: t.player_name, kind: t.kind, color: t.color, slot: t.slot, acted: t.acted === 1,
      })),
    };
  }

  // Riscrive slot e posizione dei token secondo l'ordine dato
  function writeSlot(slot, ids) {
    ids.forEach((id, i) => q.placeToken.run(slot, i, id));
  }

  function checkSlot(b, slot) {
    int(slot, 'slot');
    if (slot < b.min_slot || slot > b.max_slot) throw new OpError('slot fuori intervallo');
    return slot;
  }

  const ops = {
    create(b, op) {
      if ((q.count.get(b.slug).n) >= MAX_TOKENS) throw new OpError('troppe targhette');
      const name = str(op.name, 40, 'nome');
      if (!name) throw new OpError('nome mancante');
      const playerName = op.playerName == null ? '' : str(op.playerName, 40, 'giocatore');
      if (!KINDS.includes(op.kind)) throw new OpError('tipo non valido');
      const col = op.color == null ? KIND_COLORS[op.kind] : color(op.color);
      const slot = op.slot == null ? Math.min(Math.max(0, b.min_slot), b.max_slot) : checkSlot(b, op.slot);
      const ids = q.slotTokens.all(b.slug, slot).map((r) => r.id);
      const id = randomUUID();
      q.insertToken.run(id, b.slug, name, playerName, op.kind, col, slot, ids.length);
    },
    update(b, op) {
      const t = q.token.get(op.id, b.slug);
      if (!t) throw new OpError('targhetta inesistente');
      const name = op.name == null ? t.name : str(op.name, 40, 'nome');
      if (!name) throw new OpError('nome mancante');
      const playerName = op.playerName == null ? t.player_name : str(op.playerName, 40, 'giocatore');
      const kind = op.kind == null ? t.kind : op.kind;
      if (!KINDS.includes(kind)) throw new OpError('tipo non valido');
      const col = op.color == null ? t.color : color(op.color);
      if (op.acted != null && typeof op.acted !== 'boolean') throw new OpError('valore non valido');
      const acted = op.acted == null ? t.acted : (op.acted ? 1 : 0);
      q.updateToken.run(name, playerName, kind, col, acted, t.id);
    },
    resetTurn(b) {
      q.resetActed.run(b.slug);
    },
    move(b, op) {
      const t = q.token.get(op.id, b.slug);
      if (!t) throw new OpError('targhetta inesistente');
      const slot = checkSlot(b, op.slot);
      const index = op.index == null ? Infinity : int(op.index, 'indice');
      const from = q.slotTokens.all(b.slug, t.slot).map((r) => r.id).filter((id) => id !== t.id);
      const dest = slot === t.slot ? from : q.slotTokens.all(b.slug, slot).map((r) => r.id);
      const at = Math.max(0, Math.min(index, dest.length));
      dest.splice(at, 0, t.id);
      if (slot !== t.slot) writeSlot(t.slot, from);
      writeSlot(slot, dest);
    },
    delete(b, op) {
      const t = q.token.get(op.id, b.slug);
      if (!t) throw new OpError('targhetta inesistente');
      q.deleteToken.run(t.id);
      writeSlot(t.slot, q.slotTokens.all(b.slug, t.slot).map((r) => r.id));
    },
    config(b, op) {
      const min = int(op.minSlot, 'minimo');
      const max = int(op.maxSlot, 'massimo');
      if (min >= max) throw new OpError('il minimo deve essere minore del massimo');
      if (Math.abs(min) > SLOT_LIMIT || Math.abs(max) > SLOT_LIMIT) throw new OpError('intervallo troppo grande');
      if (max - min + 1 > MAX_SPAN) throw new OpError(`massimo ${MAX_SPAN} slot`);
      q.setRange.run(min, max, b.slug);
      // le targhette fuori intervallo vanno sullo slot di confine
      q.clampLow.run(min, b.slug, min);
      q.clampHigh.run(max, b.slug, max);
      for (const { slot } of q.slotsInUse.all(b.slug)) {
        writeSlot(slot, q.slotTokensStable.all(b.slug, slot).map((r) => r.id));
      }
    },
  };

  /** Applica un'operazione; restituisce il nuovo stato oppure lancia OpError. */
  function apply(slug, op) {
    if (!op || typeof op !== 'object' || !Object.hasOwn(ops, op.type)) throw new OpError('operazione sconosciuta');
    return tx(() => {
      const b = q.getBoard.get(slug);
      if (!b) throw new OpError('board inesistente');
      ops[op.type](b, op);
      q.touch.run(now(), slug);
      return getState(slug);
    });
  }

  function touch(slug) {
    q.touch.run(now(), slug);
  }

  function deleteExpired(ttlMs) {
    return Number(q.expired.run(now() - ttlMs).changes);
  }

  const exists = (slug) => Boolean(q.getBoard.get(slug));

  /** Elimina la board con tutte le targhette. Chiunque abbia il link può farlo (la conferma è nell'interfaccia). */
  function deleteBoard(slug) {
    return Number(q.deleteBoard.run(slug).changes) === 1;
  }

  return { exists, deleteBoard, getOrCreate, getState, apply, touch, deleteExpired };
}
