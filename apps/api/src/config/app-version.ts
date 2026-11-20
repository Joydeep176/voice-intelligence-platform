import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | undefined;

/** Version from apps/api/package.json (works from src/ under ts-jest and from dist/). */
export function appVersion(): string {
  cached ??= (
    JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  return cached;
}
