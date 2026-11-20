import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose']).default('info'),
  REDIS_URL: z.url(),
  QUEUE_FOUNDATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  QUEUE_STALLED_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  QUEUE_MAX_STALLED_COUNT: z.coerce.number().int().min(0).max(10).default(1),
  QUEUE_LOCK_DURATION_MS: z.coerce.number().int().min(1000).default(30_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});

export interface OrchestratorConfig {
  env: 'development' | 'test' | 'production';
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  redisUrl: string;
  foundation: {
    concurrency: number;
    stalledIntervalMs: number;
    maxStalledCount: number;
    lockDurationMs: number;
  };
  shutdownTimeoutMs: number;
}

export const ORCHESTRATOR_CONFIG = Symbol('ORCHESTRATOR_CONFIG');

export class ConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): OrchestratorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    redisUrl: e.REDIS_URL,
    foundation: {
      concurrency: e.QUEUE_FOUNDATION_CONCURRENCY,
      stalledIntervalMs: e.QUEUE_STALLED_INTERVAL_MS,
      maxStalledCount: e.QUEUE_MAX_STALLED_COUNT,
      lockDurationMs: e.QUEUE_LOCK_DURATION_MS,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}

/** Worker connections need maxRetriesPerRequest=null (BullMQ requirement for blocking commands). */
export function workerConnection(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
