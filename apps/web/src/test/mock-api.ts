import type { HealthResponse, ProcessingStatus, RecordingMetadata } from '@vip/contracts';
import { vi } from 'vitest';

export const WS = '00000000-0000-4000-8000-000000000001';
const now = '2026-11-19T10:00:00.000Z';

export function run(overrides: Partial<ProcessingStatus> = {}): ProcessingStatus {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    recordingId: '22222222-2222-4222-8222-222222222222',
    status: 'created',
    currentStage: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function recording(overrides: Partial<RecordingMetadata> = {}): RecordingMetadata {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    workspaceId: WS,
    originalFilename: 'synthetic-tone.wav',
    mimeType: 'audio/wav',
    sizeBytes: 12_844,
    durationMs: null,
    sha256: 'a'.repeat(64),
    status: 'uploaded',
    createdAt: now,
    updatedAt: now,
    latestRun: run(),
    ...overrides,
  };
}

export const health: HealthResponse = {
  status: 'ok',
  service: 'api',
  version: '0.1.0',
  environment: 'test',
  time: now,
  dependencies: [
    { name: 'postgres', status: 'up', latencyMs: 2, reason: null },
    { name: 'redis', status: 'up', latencyMs: 1, reason: null },
    { name: 'audio-service', status: 'up', latencyMs: 3, reason: null },
  ],
};

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
  });

export const problem = (status: number, code: string, title = 'Error') =>
  json(status, { type: `urn:vip:problem:${code.toLowerCase()}`, title, status, code });

type Handler = (
  method: string,
  url: URL,
  init?: RequestInit,
) => Response | undefined | Promise<Response | undefined>;

/** Routes fetch calls to `handler`; unhandled calls fail the test loudly. */
export function mockFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const res = await handler(init?.method ?? 'GET', url, init);
    if (!res) throw new Error(`Unhandled request: ${init?.method ?? 'GET'} ${url.pathname}`);
    return res;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
