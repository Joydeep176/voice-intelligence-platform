import { sql } from 'drizzle-orm';
import { createDb, runMigrations, type DbHandle } from '../src/index.js';

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
