import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  AudioServiceError,
  AudioServiceProbe,
  CreateRecordingRequest,
  DEV_CONSENT_STATEMENT_VERSION,
  HandshakeRequest,
  HandshakeResponse,
  PlaybackUrl,
  ProcessingStatus,
  RecordingMetadata,
  RunStatus,
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

  it.each(['../etc/passwd', 'a/b.wav', 'a\\b.wav', 'bad\u0000.wav'])(
    'rejects unsafe filename %j',
    (filename) => {
      expect(CreateRecordingRequest.safeParse({ ...validCreate, filename }).success).toBe(false);
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
