import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.js';

/**
 * Plain SQL migrations applied in filename order, each in its own transaction.
 * Migrations are append-only: add a new numbered file, never edit an applied one.
 */
export function migrate(db: Db, dir: string): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migration').all().map((r) => (r as { name: string }).name),
  );

  const pending = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => !applied.has(f));

  const record = db.prepare('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)');

  for (const file of pending) {
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }

  return pending;
}
