import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  storageUriForKey,
  ApiError,
  AudioPreprocessConfig,
  AudioServiceCapabilities,
  AudioServiceError,
  AudioServiceProbe,
  CreateRecordingRequest,
  DEV_CONSENT_STATEMENT_VERSION,
  HandshakeRequest,
  HandshakeResponse,
  PlaybackUrl,
  ProcessingStatus,
  RecordingMetadata,
  AudioPreprocessJob,
  AudioProbeJob,
  JobIds,
  ProcessingSegmentsQuery,
  ProcessingSnapshot,
  RunStatus,
  buildPreprocessConfig,
  buildProbeConfig,
  canonicalJson,
  decideRowAction,
  toolVersionsFromCapabilities,
} from './index.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/audio-service/${name}`, import.meta.url), 'utf8'));

const validCreate = {
  filename: 'synthetic-tone.wav',
  mimeType: 'audio/wav',
  sizeBytes: 1024,
  consent: { statementVersion: DEV_CONSENT_STATEMENT_VERSION, attested: true },
};

describe('CreateRecordingRequest', () => {
  it('accepts a valid request', () => {
    expect(CreateRecordingRequest.parse(validCreate).filename).toBe('synthetic-tone.wav');
  });

  it('requires consent attested === true (SEC-1)', () => {
    const result = CreateRecordingRequest.safeParse({
      ...validCreate,
      consent: { statementVersion: DEV_CONSENT_STATEMENT_VERSION, attested: false },
    });
    expect(result.success).toBe(false);
  });

  it.each([
    '../etc/passwd',
    'a/b.wav',
    'a\\b.wav',
    'bad\u0000.wav',
    'bad\u0085.wav',
    'bad\u009f.wav',
    'bad\u061c.wav',
    'bad\u200e.wav',
    'bad\u200f.wav',
    'bad\u202e.wav',
    'bad\u202a.wav',
    'bad\u2066.wav',
    'bad\u2069.wav',
  ])('rejects unsafe filename %j', (filename) => {
    expect(CreateRecordingRequest.safeParse({ ...validCreate, filename }).success).toBe(false);
  });

  it.each(['रिकॉर्डिंग_नमस्ते.wav', '会议录音.wav', 'café.wav'])(
    'accepts non-Latin filename %j',
    (filename) => {
      expect(CreateRecordingRequest.safeParse({ ...validCreate, filename }).success).toBe(true);
    },
  );

  it('rejects unsupported MIME types and non-positive sizes', () => {
    expect(
      CreateRecordingRequest.safeParse({ ...validCreate, mimeType: 'video/mp4' }).success,
    ).toBe(false);
    expect(CreateRecordingRequest.safeParse({ ...validCreate, sizeBytes: 0 }).success).toBe(false);
  });
});

describe('RunStatus', () => {
  it('includes created as the initial status (ADR-0025)', () => {
    expect(RunStatus.options[0]).toBe('created');
  });
});

describe('RecordingMetadata', () => {
  it('does not carry a storage key', () => {
    expect(Object.keys(RecordingMetadata.shape)).not.toContain('storageKey');
  });

  it('allows a null duration and null latest run', () => {
    const now = new Date().toISOString();
    const parsed = RecordingMetadata.parse({
      id: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10',
      workspaceId: '00000000-0000-4000-8000-000000000001',
      originalFilename: 'x.wav',
      mimeType: 'audio/wav',
      sizeBytes: 10,
      durationMs: null,
      sha256: null,
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
      latestRun: null,
    });
    expect(parsed.durationMs).toBeNull();
  });
});

describe('ApiError / ProcessingStatus', () => {
  it('accepts the HOST_NOT_ALLOWED code', () => {
    expect(
      ApiError.parse({
        type: 'urn:vip:problem:host_not_allowed',
        title: 'Host not allowed',
        status: 403,
        code: 'HOST_NOT_ALLOWED',
      }).code,
    ).toBe('HOST_NOT_ALLOWED');
  });

  it('parses a problem details body', () => {
    expect(
      ApiError.parse({ type: 'about:blank', title: 'Not found', status: 404, code: 'NOT_FOUND' })
        .code,
    ).toBe('NOT_FOUND');
  });

  it('rejects unknown error codes', () => {
    expect(
      ApiError.safeParse({ type: 'about:blank', title: 'x', status: 400, code: 'NOPE' }).success,
    ).toBe(false);
  });

  it('parses a created run snapshot', () => {
    const now = new Date().toISOString();
    expect(
      ProcessingStatus.parse({
        id: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10',
        recordingId: '6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b11',
        status: 'created',
        currentStage: null,
        error: null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      }).status,
    ).toBe('created');
  });
});

describe('audio-service contract fixtures (shared with Pytest)', () => {
  it('valid fixtures parse', () => {
    expect(HandshakeRequest.safeParse(fixture('handshake-request.valid.json')).success).toBe(true);
    expect(HandshakeResponse.safeParse(fixture('handshake-response.valid.json')).success).toBe(
      true,
    );
    expect(AudioServiceProbe.safeParse(fixture('probe.valid.json')).success).toBe(true);
    expect(AudioServiceError.safeParse(fixture('error.valid.json')).success).toBe(true);
  });

  it('invalid fixture is rejected', () => {
    expect(HandshakeRequest.safeParse(fixture('handshake-request.invalid.json')).success).toBe(
      false,
    );
  });
});

describe('PlaybackUrl', () => {
  it('accepts a same-origin media path with an ISO expiry', () => {
    expect(
      PlaybackUrl.safeParse({
        url: '/api/v1/media/recordings/abc.def',
        expiresAt: '2026-11-20T10:05:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects absolute or foreign URLs and bad expiry', () => {
    const expiresAt = '2026-11-20T10:05:00.000Z';
    expect(PlaybackUrl.safeParse({ url: 'https://evil.test/x', expiresAt }).success).toBe(false);
    expect(PlaybackUrl.safeParse({ url: '/api/v1/other/abc', expiresAt }).success).toBe(false);
    expect(
      PlaybackUrl.safeParse({ url: '/api/v1/media/recordings/a.b', expiresAt: 'soon' }).success,
    ).toBe(false);
  });
});

describe('processing config builder (shared by API and orchestrator)', () => {
  const capabilities = AudioServiceCapabilities.parse(fixture('capabilities.valid.json'));
  const hash = (config: unknown): string =>
    createHash('sha256').update(canonicalJson(config)).digest('hex');

  it.each(['default'])('reproduces the shared %s hash vector', () => {
    const vector = fixture('preprocess-config-hash.default.valid.json') as {
      config: unknown;
      expectedHash: string;
    };
    const toolVersions = toolVersionsFromCapabilities(capabilities);
    expect(toolVersions).not.toBeNull();
    const built = buildPreprocessConfig(toolVersions!);
    expect(built).toEqual(vector.config);
    expect(hash(built)).toBe(vector.expectedHash);
    expect(AudioPreprocessConfig.safeParse(built).success).toBe(true);
  });

  it('is deterministic and changes with the tool versions', () => {
    const base = toolVersionsFromCapabilities(capabilities)!;
    expect(hash(buildPreprocessConfig(base))).toBe(hash(buildPreprocessConfig({ ...base })));
    expect(hash(buildPreprocessConfig({ ...base, ffmpeg: '7.1.3' }))).not.toBe(
      hash(buildPreprocessConfig(base)),
    );
  });

  it('refuses capabilities that cannot preprocess', () => {
    expect(toolVersionsFromCapabilities({ ...capabilities, ffmpeg: null })).toBeNull();
    expect(toolVersionsFromCapabilities({ ...capabilities, taskTypes: ['probe'] })).toBeNull();
    expect(toolVersionsFromCapabilities({ ...capabilities, python: 'bad version!' })).toBeNull();
  });

  it('builds the probe limits config', () => {
    expect(buildProbeConfig()).toEqual({
      maxDurationMs: 14_400_000,
      maxChannels: 8,
      maxSampleRateHz: 192_000,
    });
  });
});

describe('processing DTOs and job payloads', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('job ids avoid ":" (BullMQ rejects it)', () => {
    expect(JobIds.probe(id)).not.toContain(':');
    expect(JobIds.preprocess(id)).toBe(id);
  });

  it('payloads carry IDs only and default the worker-owned fields', () => {
    expect(AudioProbeJob.parse({ workspaceId: id, recordingId: id })).toEqual({
      workspaceId: id,
      recordingId: id,
      thenPreprocess: false,
      submissions: 0,
    });
    expect(AudioPreprocessJob.safeParse({ workspaceId: id, preprocessingId: 'x' }).success).toBe(
      false,
    );
  });

  it('segment query bounds the limit', () => {
    expect(ProcessingSegmentsQuery.parse({}).limit).toBe(100);
    expect(ProcessingSegmentsQuery.safeParse({ limit: '1001' }).success).toBe(false);
    expect(ProcessingSegmentsQuery.safeParse({ fromMs: '-1' }).success).toBe(false);
    expect(ProcessingSegmentsQuery.parse({ fromMs: '5', limit: '1000' })).toEqual({
      fromMs: 5,
      limit: 1000,
    });
  });

  it('snapshot allows an unstarted recording', () => {
    expect(
      ProcessingSnapshot.safeParse({
        state: 'not_started',
        recording: { status: 'uploaded', validationError: null },
        probe: null,
        preprocessing: null,
      }).success,
    ).toBe(true);
  });
});

describe('decideRowAction (retry rules)', () => {
  it('returns a succeeded version without running anything', () => {
    expect(decideRowAction({ status: 'succeeded', attempt: 1 }, 3)).toEqual({ kind: 'return' });
  });

  it('keeps a live version and lets the queue dedupe the job', () => {
    expect(decideRowAction({ status: 'queued', attempt: 0 }, 3)).toEqual({ kind: 'enqueue' });
    expect(decideRowAction({ status: 'running', attempt: 1 }, 3)).toEqual({ kind: 'enqueue' });
  });

  it.each(['failed', 'cancelled'] as const)(
    'retries a %s version only while attempts remain',
    (status) => {
      expect(decideRowAction({ status, attempt: 2 }, 3)).toEqual({ kind: 'retry' });
      expect(decideRowAction({ status, attempt: 3 }, 3).kind).toBe('reject');
      expect(decideRowAction({ status, attempt: 9 }, 3).kind).toBe('reject');
    },
  );
});

describe('storageUriForKey', () => {
  it('keeps the local scheme without an authority', () => {
    expect(storageUriForKey('local://recordings/w/r/original', 'derived/x')).toBe(
      'local://derived/x',
    );
  });

  it('keeps the bucket of an object-store URI', () => {
    expect(storageUriForKey('s3://bucket/recordings/w/r/original', 'derived/x')).toBe(
      's3://bucket/derived/x',
    );
    expect(storageUriForKey('s3://bucket/k', 'derived/x')).toBe('s3://bucket/derived/x');
  });

  it('rejects a reference without a scheme', () => {
    expect(() => storageUriForKey('no-scheme', 'k')).toThrow();
  });
});
