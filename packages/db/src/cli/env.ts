export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is not set. Copy .env.example to .env first.\n');
    process.exit(1);
  }
  return url;
}
