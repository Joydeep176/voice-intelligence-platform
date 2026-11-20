import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` is used; it needs no database connection.
// Migrations are applied by `pnpm db:migrate` (src/cli/migrate.ts) so CLI and tests share one path.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
});
