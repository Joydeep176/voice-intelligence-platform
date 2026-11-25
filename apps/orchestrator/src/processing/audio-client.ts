import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  AudioServiceCapabilities,
  AudioServiceError,
  AudioTaskAccepted,
  AudioTaskState,
  type AudioTaskCreateRequest,
} from '@vip/contracts';
import type { z } from 'zod';

/**
 * Content-free failure kinds of the audio service client. Retry policy lives in the step jobs:
 *  - LOST: 404 TASK_NOT_FOUND, the service forgot the task (restart/eviction): resubmit, bounded.
 *  - BUSY: 503 CAPACITY_EXCEEDED: retry later.
 *  - CONFIG: 401, the token is wrong: not retryable.
 *  - REJECTED: the service refused the request on its merits (4xx): not retryable.
 *  - UNAVAILABLE / INVALID_RESPONSE: transport, 5xx or a response that breaks the contract: retry.
 */
export type AudioClientFailure =
  'LOST' | 'BUSY' | 'CONFIG' | 'REJECTED' | 'UNAVAILABLE' | 'INVALID_RESPONSE';

export class AudioClientError extends Error {
  constructor(
    readonly kind: AudioClientFailure,
    /** The service's error code, when it sent a well-formed problem. */
    readonly code?: string,
    readonly status?: number,
  ) {
    super(`Audio service request failed: ${kind}`);
    this.name = 'AudioClientError';
  }
}

/** The calls the coordinator makes; tests substitute a fake. */
export interface AudioTasks {
  capabilities(): Promise<AudioServiceCapabilities>;
  submit(request: AudioTaskCreateRequest): Promise<AudioTaskAccepted>;
  get(taskId: string): Promise<AudioTaskState>;
  cancel(taskId: string): Promise<AudioTaskAccepted>;
}

export interface AudioClientConfig {
  url: string;
  token: string;
  timeoutMs: number;
}

/** Typed audio service client (contract v2): bearer token, bounded timeout, validated responses. */
export class AudioClient implements AudioTasks {
  constructor(private readonly config: AudioClientConfig) {}

  capabilities(): Promise<AudioServiceCapabilities> {
    return this.request('/v1/capabilities', { method: 'GET' }, AudioServiceCapabilities);
  }

  submit(request: AudioTaskCreateRequest): Promise<AudioTaskAccepted> {
    return this.request(
      '/v1/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, contractVersion: AUDIO_SERVICE_CONTRACT_VERSION }),
      },
      AudioTaskAccepted,
    );
  }

  get(taskId: string): Promise<AudioTaskState> {
    return this.request(
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'GET' },
      AudioTaskState,
    );
  }

  cancel(taskId: string): Promise<AudioTaskAccepted> {
    return this.request(
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      { method: 'DELETE' },
      AudioTaskAccepted,
    );
  }

  private async request<T extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.config.token}`);
    let response: Response;
    try {
      response = await fetch(`${this.config.url}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch {
      throw new AudioClientError('UNAVAILABLE');
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw classify(response.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AudioClientError('INVALID_RESPONSE', undefined, response.status);
    return parsed.data;
  }
}

/** Maps an error response to a failure kind. Bodies are parsed for the code only, never logged. */
export function classify(status: number, body: unknown): AudioClientError {
  const problem = AudioServiceError.safeParse(body);
  const code = problem.success ? problem.data.code : undefined;
  if (status === 401) return new AudioClientError('CONFIG', code, status);
  if (status === 404 && code === 'TASK_NOT_FOUND')
    return new AudioClientError('LOST', code, status);
  if (status === 503 && code === 'CAPACITY_EXCEEDED')
    return new AudioClientError('BUSY', code, status);
  if (status >= 500) return new AudioClientError('UNAVAILABLE', code, status);
  return new AudioClientError('REJECTED', code, status);
}
