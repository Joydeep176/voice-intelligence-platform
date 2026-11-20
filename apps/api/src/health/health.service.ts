import { Inject, Injectable } from '@nestjs/common';
import type { DependencyHealth, HealthResponse, HealthState } from '@vip/contracts';
import type { DbHandle } from '@vip/db';
import {
  AudioServiceClient,
  AudioServiceUnavailableError,
} from '../audio-service/audio-service.client';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { appVersion } from '../config/app-version';
import { DB_HANDLE } from '../database/database.module';
import { FoundationCheckProducer } from '../queue/foundation-check.producer';

const CHECK_TIMEOUT_MS = 2000;

class CheckTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(FoundationCheckProducer) private readonly queue: FoundationCheckProducer,
    @Inject(AudioServiceClient) private readonly audio: AudioServiceClient,
  ) {}

  /** Postgres and Redis are required; the audio service is reported but not required yet. */
  async readiness(): Promise<HealthState> {
    const [pg, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);
    return pg.status === 'up' && redis.status === 'up' ? 'ok' : 'down';
  }

  async full(): Promise<HealthResponse> {
    const dependencies = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkAudioService(),
    ]);
    const required = dependencies.filter((d) => d.name !== 'audio-service');
    const status: HealthState = required.some((d) => d.status === 'down')
      ? 'down'
      : dependencies.some((d) => d.status === 'down')
        ? 'degraded'
        : 'ok';
    return {
      status,
      service: 'api',
      version: appVersion(),
      environment: this.config.env,
      time: new Date().toISOString(),
      dependencies,
    };
  }

  private checkPostgres(): Promise<DependencyHealth> {
    return this.measure('postgres', async () => {
      await this.db.pool.query('SELECT 1');
    });
  }

  private checkRedis(): Promise<DependencyHealth> {
    return this.measure('redis', () => this.queue.ping());
  }

  private checkAudioService(): Promise<DependencyHealth> {
    return this.measure('audio-service', async () => {
      await this.audio.handshake();
    });
  }

  private async measure(
    name: DependencyHealth['name'],
    check: () => Promise<void>,
  ): Promise<DependencyHealth> {
    const started = Date.now();
    try {
      await withTimeout(check(), CHECK_TIMEOUT_MS);
      return { name, status: 'up', latencyMs: Date.now() - started, reason: null };
    } catch (error) {
      const reason =
        error instanceof CheckTimeout
          ? 'TIMEOUT'
          : error instanceof AudioServiceUnavailableError
            ? error.reason
            : 'UNREACHABLE';
      return { name, status: 'down', latencyMs: null, reason };
    }
  }
}
