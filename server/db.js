import { DatabaseSync } from 'node:sqlite';

export function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS boards (
      slug TEXT PRIMARY KEY,
      min_slot INTEGER NOT NULL,
      max_slot INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tokens (
      id TEXT PRIMARY KEY,
      board_slug TEXT NOT NULL REFERENCES boards(slug) ON DELETE CASCADE,
      name TEXT NOT NULL,
      player_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      color TEXT NOT NULL,
      slot INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tokens_board ON tokens(board_slug, slot, position);
  `);
  // migrazione: colonna "ha già agito in questo turno" (i database esistenti non la hanno)
  const cols = db.prepare('PRAGMA table_info(tokens)').all().map((c) => c.name);
  if (!cols.includes('acted')) db.exec('ALTER TABLE tokens ADD COLUMN acted INTEGER NOT NULL DEFAULT 0');
  return db;
}

export function openDb(path = ':memory:') {
  return initSchema(new DatabaseSync(path));
}
