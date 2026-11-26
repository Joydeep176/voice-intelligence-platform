import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  AudioServiceCapabilities,
  AudioServiceError,
  AudioLevelSeries,
  AudioPreprocessConfig,
  AudioPreprocessResult,
  AudioProbeResult,
  AudioServiceProbe,
  AudioTaskAccepted,
  AudioTaskCreateRequest,
  AudioTaskState,
  AudioTimeline,
  AudioDiarizeConfig,
  AudioDiarizeResult,
  AudioMeasureConfig,
  AudioMeasureResult,
  AudioTranscribeConfig,
  AudioTranscribeResult,
  HandshakeRequest,
  HandshakeResponse,
  canonicalJson,
} from './audio-service.js';

/**
 * Parity with services/audio/tests/test_contracts.py: every fixture named
 * `<schema>.<label>.valid.json` or `.invalid.json` must be accepted or rejected as named, by the
 * zod schema here and the Pydantic mirror there. An unmapped schema fails this suite.
 */
const SCHEMAS: Record<string, ZodType> = {
  'handshake-request': HandshakeRequest,
  'handshake-response': HandshakeResponse,
  probe: AudioServiceProbe,
  error: AudioServiceError,
  'task-create-request': AudioTaskCreateRequest,
  'task-accepted': AudioTaskAccepted,
  'task-status': AudioTaskState,
  capabilities: AudioServiceCapabilities,
  'probe-result': AudioProbeResult,
  timeline: AudioTimeline,
  'preprocess-config': AudioPreprocessConfig,
  'preprocess-config-hash': z
    .object({
      config: AudioPreprocessConfig,
      canonicalJson: z.string(),
      expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
  'preprocess-result': AudioPreprocessResult,
  'level-series': AudioLevelSeries,
  'transcribe-config': AudioTranscribeConfig,
  'transcribe-result': AudioTranscribeResult,
  'diarize-config': AudioDiarizeConfig,
  'diarize-result': AudioDiarizeResult,
  'measure-config': AudioMeasureConfig,
  'measure-result': AudioMeasureResult,
};

const dir = new URL('../fixtures/audio-service/', import.meta.url);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('audio-service contract v2 fixtures (shared with Pytest)', () => {
  it('has the fixture set', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(AUDIO_SERVICE_CONTRACT_VERSION).toBe('2');
  });

  it.each(files)('%s', (name) => {
    const parts = name.split('.');
    const label = parts[parts.length - 2];
    const schema = SCHEMAS[parts[0] as string];
    expect(schema, `schema for ${name} is not mapped`).toBeDefined();
    expect(['valid', 'invalid']).toContain(label);
    const body: unknown = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    expect(schema!.safeParse(body).success).toBe(label === 'valid');
  });
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('preprocess config canonical JSON and hash (parity with Pytest)', () => {
  const vectors = files.filter((f) => /^preprocess-config-hash\..*\.valid\.json$/.test(f));

  it('has the shared vectors', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3);
  });

  it.each(vectors)('%s: canonical JSON and SHA-256 match the stored values', (name) => {
    const vector = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as {
      config: unknown;
      canonicalJson: string;
      expectedHash: string;
    };
    expect(canonicalJson(vector.config)).toBe(vector.canonicalJson);
    expect(sha256(canonicalJson(vector.config))).toBe(vector.expectedHash);
  });

  it('sorts keys recursively, drops whitespace and does not escape non-ASCII', () => {
    expect(canonicalJson({ b: [1, 'é\n'], a: { z: 1, y: '"' } })).toBe(
      '{"a":{"y":"\\"","z":1},"b":[1,"é\\n"]}',
    );
  });

  it('rejects floats, booleans, null and undefined', () => {
    for (const bad of [1.5, true, null, undefined, { a: 0.1 }, [Number.NaN]]) {
      expect(() => canonicalJson(bad)).toThrow();
    }
  });
});

describe('review remediation additions (task deadline, RESOURCE_EXHAUSTED, Landlock scoping)', () => {
  const base = {
    taskId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10',
    type: 'preprocess',
    status: 'running',
    progress: null,
    result: null,
    error: null,
  };

  it('accepts a task state with and without deadlineAt (older services omit it)', () => {
    expect(AudioTaskState.safeParse(base).success).toBe(true);
    expect(AudioTaskState.safeParse({ ...base, deadlineAt: null }).success).toBe(true);
    expect(AudioTaskState.safeParse({ ...base, deadlineAt: 1795000000000 }).success).toBe(true);
  });

  it.each([1.5, -1, '1795000000000'])('rejects deadlineAt %s', (deadlineAt) => {
    expect(AudioTaskState.safeParse({ ...base, deadlineAt }).success).toBe(false);
  });

  it('knows RESOURCE_EXHAUSTED as an error code', () => {
    const failed = {
      ...base,
      status: 'failed',
      error: { code: 'RESOURCE_EXHAUSTED', retryable: true },
    };
    expect(AudioTaskState.safeParse(failed).success).toBe(true);
  });

  it('accepts landlock.scoped as a boolean, absent for older services, and nothing else', () => {
    const caps = (scoped: unknown) => ({
      contractVersion: '2',
      serviceVersion: '0.1.0',
      python: '3.12.8',
      ffmpeg: null,
      numpy: '2.5.5',
      vad: 'none',
      landlock: {
        supported: true,
        abi: 6,
        enforced: true,
        ...(scoped === undefined ? {} : { scoped }),
      },
      taskTypes: [],
    });
    expect(AudioServiceCapabilities.safeParse(caps(undefined)).success).toBe(true);
    expect(AudioServiceCapabilities.safeParse(caps(true)).success).toBe(true);
    expect(AudioServiceCapabilities.safeParse(caps('yes')).success).toBe(false);
  });
});

describe('Tier 1 wire contract bounds (Phase 3A security review)', () => {
  const valid = JSON.parse(readFileSync(new URL('measure-result.valid.json', dir), 'utf8')) as {
    record: { quantities: Record<string, { value: number }> };
    series: { speechMs: number[]; snrDb: (number | null)[] };
  };
  it('rejects a series longer than 200,000 blocks', () => {
    const long = structuredClone(valid);
    long.series.speechMs = Array(200_001).fill(0);
    long.series.snrDb = Array(200_001).fill(null);
    expect(AudioMeasureResult.safeParse(long).success).toBe(false);
  });
  it('rejects more than 32 quantities', () => {
    const many = structuredClone(valid);
    const [first] = Object.values(many.record.quantities);
    for (let i = 0; i < 33; i++) many.record.quantities[`q${i}`] = first!;
    expect(AudioMeasureResult.safeParse(many).success).toBe(false);
  });
});
