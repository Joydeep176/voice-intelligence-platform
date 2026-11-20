import { createDb } from '../client.js';
import { seedDevelopment } from '../seed.js';
import { requireDatabaseUrl } from './env.js';

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed development data with NODE_ENV=production.\n');
  process.exit(1);
}
const handle = createDb(requireDatabaseUrl(), { maxConnections: 1 });
try {
  await seedDevelopment(handle.db);
  process.stdout.write('Development workspace seeded.\n');
} finally {
  await handle.close();
}
