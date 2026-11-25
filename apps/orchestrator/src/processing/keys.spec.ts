import { readFileSync } from 'node:fs';
import { configHashOf, idempotencyKey, originalKey, outputPrefix, uriForKey } from './keys';

const W = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const H = 'a'.repeat(64);

describe('storage keys', () => {
  it('builds keys in the layout the audio service validates', () => {
    expect(originalKey(W, R)).toBe(`recordings/${W}/${R}/original`);
    expect(outputPrefix(W, R, H)).toBe(`derived/${W}/${R}/${H}`);
  });

  it('keeps the URI scheme of the recording', () => {
    expect(uriForKey(`local://recordings/${W}/${R}/original`, 'derived/x/canonical.wav')).toBe(
      'local://derived/x/canonical.wav',
    );
    expect(uriForKey('s3://bucket/k', 'derived/x')).toBe('s3://bucket/derived/x'); // bucket kept
    expect(() => uriForKey('no-scheme', 'k')).toThrow();
  });
});

describe('idempotencyKey', () => {
  it('has no suffix for the first submission and a counter afterwards', () => {
    expect(idempotencyKey(R, H, 'preprocess', 1)).toBe(`${R}:${H}:preprocess`);
    expect(idempotencyKey(R, H, 'preprocess', 2)).toBe(`${R}:${H}:preprocess:2`);
    expect(idempotencyKey(R, H, 'probe', 3)).toBe(`${R}:${H}:probe:3`);
  });

  it('stays within the service limit of 128 characters', () => {
    expect(idempotencyKey(R, H, 'preprocess', 10).length).toBeLessThanOrEqual(128);
  });
});

describe('configHashOf', () => {
  it('reproduces the shared hash vector (parity with the Python service)', () => {
    const vector = JSON.parse(
      readFileSync(
        new URL(
          '../../../../packages/contracts/fixtures/audio-service/preprocess-config-hash.default.valid.json',
          `file://${__dirname}/`,
        ),
        'utf8',
      ),
    ) as { config: unknown; expectedHash: string };
    expect(configHashOf(vector.config)).toBe(vector.expectedHash);
  });
});
