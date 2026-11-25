import type { ProcessingPreprocessing, ProcessingSnapshot } from '@vip/contracts';

export const REC_ID = '22222222-2222-4222-8222-222222222222';
export const NOW = Date.parse('2026-11-21T10:00:00.000Z');
export const iso = (offsetMs = 0) => new Date(NOW + offsetMs).toISOString();

const quantity = (value: number, unit: string, kind = 'measured', method = 'test method') => ({
  value,
  unit,
  kind,
  method,
});

export const canonicalRecord = {
  measurementsSchemaVersion: 1,
  source: 'canonical',
  sampleRateHz: 16000,
  channels: 1,
  frames: 160000,
  quantities: {
    peakDbfs: quantity(-3.2, 'dBFS'),
    rmsDbfs: quantity(-20.5, 'dBFS'),
    crestFactorDb: quantity(17.3, 'dB', 'derived'),
    silenceRatio: quantity(0.125, 'ratio', 'estimate'),
  },
  perChannel: [],
  unavailable: [
    { name: 'snr', reason: 'no_speech_split' },
    { name: 'harmonicDistortion', reason: 'no_reference' },
  ],
};

export const originalRecord = {
  ...canonicalRecord,
  source: 'original_decoded',
  sampleRateHz: 44100,
  channels: 2,
  frames: 441000,
  quantities: { peakDbfs: quantity(-1, 'dBFS') },
  unavailable: [],
};

export function pre(over: Partial<ProcessingPreprocessing> = {}): ProcessingPreprocessing {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    status: 'queued',
    progress: null,
    attempt: 1,
    maxRetries: 3,
    error: null,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    configHash: 'h'.repeat(64),
    canonical: null,
    timeline: null,
    measurements: [],
    vad: null,
    segmentCount: null,
    ...over,
  };
}

export function snap(
  state: ProcessingSnapshot['state'],
  over: Partial<ProcessingSnapshot> = {},
): ProcessingSnapshot {
  return {
    state,
    recording: { status: 'valid', validationError: null },
    probe: {
      container: 'wav',
      codec: 'pcm_s16le',
      sampleRateHz: 44100,
      channels: 2,
      durationMs: 10000,
    },
    preprocessing: null,
    ...over,
  };
}

export const processing = (fraction: number | null = 0.4, updatedAt = iso(), stage = 'decode') =>
  snap('processing', {
    preprocessing: pre({
      status: 'running',
      progress: fraction === null ? null : { stage, fraction, processedMs: 4000, updatedAt },
    }),
  });

export const completed = () =>
  snap('completed', {
    preprocessing: pre({
      status: 'succeeded',
      canonical: { durationMs: 10000, sha256: 'a'.repeat(64) },
      timeline: {
        mappingStatus: 'exact',
        mappingErrorBoundMs: null,
        decodeClass: 'full',
        decodedUntilMs: null,
        gapCount: 0,
      },
      measurements: [
        {
          source: 'original_decoded',
          schemaVersion: '1',
          serviceVersion: '0.1.0',
          record: originalRecord,
        },
        {
          source: 'canonical',
          schemaVersion: '1',
          serviceVersion: '0.1.0',
          record: canonicalRecord,
        },
      ],
      vad: { method: 'none', status: 'not_configured' },
      segmentCount: 0,
    }),
  });

export const failed = (over: Partial<ProcessingPreprocessing> = {}) =>
  snap('failed', {
    preprocessing: pre({
      status: 'failed',
      attempt: 1,
      error: { code: 'TIMEOUT', retryable: true },
      ...over,
    }),
  });

export const cancelled = (over: Partial<ProcessingPreprocessing> = {}) =>
  snap('cancelled', { preprocessing: pre({ status: 'cancelled', attempt: 1, ...over }) });
