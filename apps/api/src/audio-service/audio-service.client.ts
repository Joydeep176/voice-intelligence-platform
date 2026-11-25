import { Inject, Injectable } from '@nestjs/common';
import {
  AUDIO_SERVICE_CONTRACT_VERSION,
  AudioServiceCapabilities,
  AudioServiceError,
  AudioServiceProbe,
  HandshakeResponse,
  type HandshakeResponse as Handshake,
} from '@vip/contracts';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

/** Content-free failure reasons; never includes response bodies or URLs. */
export type AudioServiceFailure =
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'BAD_STATUS'
  | 'INVALID_RESPONSE'
  | 'CONTRACT_VERSION_MISMATCH';

export class AudioServiceUnavailableError extends Error {
  constructor(
    readonly reason: AudioServiceFailure,
    readonly status?: number,
  ) {
    super(`Audio service unavailable: ${reason}`);
    this.name = 'AudioServiceUnavailableError';
  }
}

/**
 * Typed client for the Python audio service internal API (LLD §3.1, ADR-0002 prototype).
 * Covers probes, the handshake and `GET /v1/capabilities` (tool versions for the config hash).
 * Tasks are submitted and polled by the orchestrator, never by the API.
 * Every request carries `Authorization: Bearer <AUDIO_SERVICE_TOKEN>` (ADR-0035); without a
 * configured token the client fails with `NOT_CONFIGURED` and sends nothing.
 * Responses are validated against `@vip/contracts` before use.
 */
@Injectable()
export class AudioServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  ready(): Promise<z.infer<typeof AudioServiceProbe>> {
    return this.request('/health/ready', { method: 'GET' }, AudioServiceProbe);
  }

  handshake(): Promise<Handshake> {
    const requestId = randomUUID();
    return this.request(
      '/v1/handshake',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractVersion: AUDIO_SERVICE_CONTRACT_VERSION, requestId }),
      },
      HandshakeResponse,
    ).then((res) => {
      if (res.requestId !== requestId || res.contractVersion !== AUDIO_SERVICE_CONTRACT_VERSION) {
        throw new AudioServiceUnavailableError('CONTRACT_VERSION_MISMATCH');
      }
      return res;
    });
  }

  /** Tool versions and limits the service measured at startup (contract v2). */
  capabilities(): Promise<AudioServiceCapabilities> {
    return this.request('/v1/capabilities', { method: 'GET' }, AudioServiceCapabilities);
  }

  private async request<T extends z.ZodType>(
    path: string,
    init: RequestInit,
    schema: T,
  ): Promise<z.infer<T>> {
    const { token } = this.config.audioService;
    if (token === undefined) throw new AudioServiceUnavailableError('NOT_CONFIGURED');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${this.config.audioService.url}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.config.audioService.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      throw new AudioServiceUnavailableError(name === 'TimeoutError' ? 'TIMEOUT' : 'UNREACHABLE');
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const problem = AudioServiceError.safeParse(body);
      if (problem.success && problem.data.code === 'CONTRACT_VERSION_MISMATCH') {
        throw new AudioServiceUnavailableError('CONTRACT_VERSION_MISMATCH', response.status);
      }
      if (response.status === 401) {
        throw new AudioServiceUnavailableError('UNAUTHORIZED', response.status);
      }
      throw new AudioServiceUnavailableError('BAD_STATUS', response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new AudioServiceUnavailableError('INVALID_RESPONSE', response.status);
    return parsed.data;
  }
}
