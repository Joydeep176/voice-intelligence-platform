import type { AudioMeasurement, AudioPreprocessing, Recording } from '@vip/db';
import { probeSummary, stateOf, toSnapshot } from './processing.mapper';

const now = new Date('2026-11-21T10:00:00Z');
const ID = '00000000-0000-4000-8000-000000000001';

const recording = (over: Partial<Recording> = {}): Recording =>
  ({
    id: ID,
    workspaceId: ID,
    status: 'valid',
    validationError: null,
    mediaProbe: null,
    durationMs: null,
    ...over,
  }) as Recording;

const row = (over: Partial<AudioPreprocessing> = {}): AudioPreprocessing =>
  ({
    id: ID,
    status: 'queued',
    attempt: 0,
    configHash: 'a'.repeat(64),
    progress: null,
    error: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    canonicalSha256: null,
    canonicalDurationMs: null,
    timeline: null,
    vad: null,
    ...over,
  }) as AudioPreprocessing;

describe('stateOf', () => {
  it.each([
    ['uploaded', null, 'not_started'],
    ['valid', null, 'not_started'],
    ['validating', null, 'validating'],
    ['invalid', null, 'failed'],
    ['valid', 'queued', 'queued'],
    ['valid', 'running', 'processing'],
    ['valid', 'succeeded', 'completed'],
    ['valid', 'failed', 'failed'],
    ['valid', 'cancelled', 'cancelled'],
  ] as const)('recording %s + preprocessing %s -> %s', (recordingStatus, pre, expected) => {
    expect(
      stateOf(
        { status: recordingStatus },
        pre === null ? null : { status: pre as AudioPreprocessing['status'] },
      ),
    ).toBe(expected);
  });
});

describe('probeSummary', () => {
  it('is null without a probe and null-fills unknown fields', () => {
    expect(probeSummary(recording())).toBeNull();
    expect(
      probeSummary(recording({ mediaProbe: { container: 'wav', codec: 7 }, durationMs: 1500 })),
    ).toEqual({
      container: 'wav',
      codec: null,
      sampleRateHz: null,
      channels: null,
      durationMs: 1500,
    });
  });
});

describe('toSnapshot', () => {
  it('never fabricates: nothing known means nulls', () => {
    const snap = toSnapshot(recording({ status: 'uploaded' }), null, [], null, 3);
    expect(snap).toEqual({
      state: 'not_started',
      recording: { status: 'uploaded', validationError: null },
      probe: null,
      preprocessing: null,
    });
  });

  it('reports persisted progress, error and cancel request only', () => {
    const snap = toSnapshot(
      recording(),
      row({
        status: 'running',
        attempt: 2,
        progress: {
          stage: 'decode',
          fraction: 0.4,
          processedMs: 4000,
          updatedAt: now.toISOString(),
        },
        cancelRequestedAt: now,
        startedAt: now,
      }),
      [],
      null,
      3,
    );
    expect(snap.state).toBe('processing');
    expect(snap.preprocessing).toMatchObject({
      attempt: 2,
      maxRetries: 3,
      cancelRequested: true,
      progress: { stage: 'decode', fraction: 0.4, processedMs: 4000 },
      canonical: null,
      timeline: null,
      segmentCount: null,
    });
  });

  it('drops malformed stored progress instead of guessing', () => {
    const snap = toSnapshot(recording(), row({ progress: { stage: 'x' } }), [], null, 3);
    expect(snap.preprocessing?.progress).toBeNull();
  });

  it('maps a failed row with its code and retryability', () => {
    const snap = toSnapshot(
      recording(),
      row({ status: 'failed', error: { code: 'TIMEOUT', retryable: true }, finishedAt: now }),
      [],
      null,
      3,
    );
    expect(snap.state).toBe('failed');
    expect(snap.preprocessing?.error).toEqual({ code: 'TIMEOUT', retryable: true });
  });

  it('exposes whole-recording measurements as stored', () => {
    const m = {
      source: 'canonical',
      schemaVersion: '1',
      serviceVersion: '0.1.0',
      measurements: { quantities: {} },
    } as unknown as AudioMeasurement;
    const snap = toSnapshot(
      recording(),
      row({ status: 'succeeded', canonicalSha256: 'b'.repeat(64), canonicalDurationMs: 1000 }),
      [m],
      0,
      3,
    );
    expect(snap.preprocessing?.measurements).toEqual([
      {
        source: 'canonical',
        schemaVersion: '1',
        serviceVersion: '0.1.0',
        record: { quantities: {} },
      },
    ]);
    expect(snap.preprocessing?.canonical).toEqual({ durationMs: 1000, sha256: 'b'.repeat(64) });
    expect(snap.preprocessing?.segmentCount).toBe(0);
  });
});
