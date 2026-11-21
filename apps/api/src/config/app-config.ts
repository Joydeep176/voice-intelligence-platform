import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

export const APP_CONFIG = Symbol('APP_CONFIG');

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1));

/** Loopback bind addresses permitted while authentication is disabled (SEC-05). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose']).default('info'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_CORS_ORIGINS: csv.default(['http://localhost:5173']),
    /** Only `dev` exists: authentication is not implemented (OD-08b, OD-27). */
    AUTH_MODE: z.literal('dev'),
    DEV_WORKSPACE_ID: z.uuid(),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    REDIS_URL: z.url(),
    /** Only `local` is implemented; the StorageService interface is S3-ready. */
    STORAGE_DRIVER: z.literal('local').default('local'),
    STORAGE_LOCAL_ROOT: z.string().min(1).default('.local-storage'),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 ** 3),
    UPLOAD_PART_SIZE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 ** 2)
      .default(8 * 1024 ** 2),
    UPLOAD_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(1440),
    AUDIO_SERVICE_URL: z.url(),
    AUDIO_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3000),
    /** HMAC key for playback URLs (ADR-0033). Required, no default; never logged. */
    MEDIA_URL_SIGNING_SECRET: z
      .string()
      .min(32)
      .refine((v) => !v.startsWith('change-me'), 'placeholder secret'),
    MEDIA_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    QUEUE_FOUNDATION_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    QUEUE_FOUNDATION_BACKOFF_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  })
  .refine((env) => env.AUTH_MODE !== 'dev' || LOOPBACK_HOSTS.has(env.API_HOST.toLowerCase()), {
    path: ['API_HOST'],
    message: 'API_HOST must be a loopback address while authentication is disabled (AUTH_MODE=dev)',
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.AUTH_MODE === 'dev'), {
    path: ['AUTH_MODE'],
    message: 'AUTH_MODE=dev is not allowed in production (authentication is not implemented)',
  });

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  logLevel: z.infer<typeof EnvSchema>['LOG_LEVEL'];
  host: string;
  port: number;
  corsOrigins: string[];
  auth: { mode: 'dev'; devWorkspaceId: string; devPrincipalId: string };
  database: { url: string; poolMax: number };
  redis: { url: string };
  storage: { driver: 'local'; localRoot: string };
  upload: { maxBytes: number; partSizeBytes: number; sessionTtlMinutes: number };
  audioService: { url: string; timeoutMs: number };
  playback: { signingSecret: string; urlTtlSeconds: number };
  queues: { foundation: { attempts: number; backoffMs: number } };
}

export class ConfigError extends Error {
  constructor(readonly variables: string[]) {
    // Names only: values may be secrets.
    super(`Invalid or missing environment variables: ${variables.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Walks up from `start` to the directory containing pnpm-workspace.yaml. */
export function findRepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError([...new Set(parsed.error.issues.map((i) => String(i.path[0])))]);
  }
  const e = parsed.data;
  const localRoot = isAbsolute(e.STORAGE_LOCAL_ROOT)
    ? e.STORAGE_LOCAL_ROOT
    : join(findRepoRoot(), e.STORAGE_LOCAL_ROOT);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    host: e.API_HOST,
    port: e.API_PORT,
    corsOrigins: e.API_CORS_ORIGINS,
    auth: { mode: e.AUTH_MODE, devWorkspaceId: e.DEV_WORKSPACE_ID, devPrincipalId: 'dev-local' },
    database: { url: e.DATABASE_URL, poolMax: e.DATABASE_POOL_MAX },
    redis: { url: e.REDIS_URL },
    storage: { driver: e.STORAGE_DRIVER, localRoot },
    upload: {
      maxBytes: e.UPLOAD_MAX_BYTES,
      partSizeBytes: e.UPLOAD_PART_SIZE_BYTES,
      sessionTtlMinutes: e.UPLOAD_SESSION_TTL_MINUTES,
    },
    audioService: {
      url: e.AUDIO_SERVICE_URL.replace(/\/$/, ''),
      timeoutMs: e.AUDIO_SERVICE_TIMEOUT_MS,
    },
    playback: { signingSecret: e.MEDIA_URL_SIGNING_SECRET, urlTtlSeconds: e.MEDIA_URL_TTL_SECONDS },
    queues: {
      foundation: {
        attempts: e.QUEUE_FOUNDATION_ATTEMPTS,
        backoffMs: e.QUEUE_FOUNDATION_BACKOFF_MS,
      },
    },
  };
}
