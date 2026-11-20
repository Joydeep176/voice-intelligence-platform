import { z } from 'zod';
import { IsoDateTime } from './common.js';

export const HealthState = z.enum(['ok', 'degraded', 'down']);
export type HealthState = z.infer<typeof HealthState>;

/** Status of one dependency. Never includes hosts, credentials or connection strings. */
export const DependencyHealth = z.object({
  name: z.enum(['postgres', 'redis', 'audio-service']),
  status: z.enum(['up', 'down']),
  latencyMs: z.number().int().nonnegative().nullable(),
  /** Stable, content-free reason code when down, e.g. `TIMEOUT`, `UNREACHABLE`. */
  reason: z.string().max(64).nullable(),
});
export type DependencyHealth = z.infer<typeof DependencyHealth>;

/** `GET /api/v1/health`: application health plus dependency status. */
export const HealthResponse = z.object({
  status: HealthState,
  service: z.literal('api'),
  version: z.string(),
  environment: z.enum(['development', 'test', 'production']),
  time: IsoDateTime,
  dependencies: z.array(DependencyHealth),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `GET /api/v1/health/live` and `/ready` (API §8). */
export const ProbeResponse = z.object({
  status: HealthState,
});
export type ProbeResponse = z.infer<typeof ProbeResponse>;
