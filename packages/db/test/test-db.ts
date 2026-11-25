import { sql } from 'drizzle-orm';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, migrationsFolder, runMigrations, type DbHandle } from '../src/index.js';

/** Connection string for the disposable test database. Never the development database. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example).');
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": test database names must end in _test.`);
  }
  return url;
}

/** Drops everything in the test database and re-applies all migrations from scratch. */
export async function resetTestDatabase(): Promise<DbHandle> {
  const handle = createDb(testDatabaseUrl(), { maxConnections: 2 });
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  await runMigrations(handle.db);
  return handle;
}

/**
 * Drops everything and applies only the first `count` migrations (from a trimmed copy of the
 * migrations folder), so a test can populate older-schema rows before applying the rest.
 */
export async function resetTestDatabaseUpTo(count: number): Promise<DbHandle> {
  const handle = createDb(testDatabaseUrl(), { maxConnections: 2 });
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await handle.db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await handle.db.execute(sql`CREATE SCHEMA public`);
  const folder = mkdtempSync(join(tmpdir(), 'vip-migrations-'));
  cpSync(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  writeFileSync(journalPath, JSON.stringify(journal));
  await migrate(handle.db, { migrationsFolder: folder });
  return handle;
}
