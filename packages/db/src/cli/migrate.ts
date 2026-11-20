import { createDb, runMigrations } from '../client.js';
import { requireDatabaseUrl } from './env.js';

const handle = createDb(requireDatabaseUrl(), { maxConnections: 1 });
try {
  await runMigrations(handle.db);
  process.stdout.write('Migrations applied.\n');
} finally {
  await handle.close();
}
