import type { ConnectionOptions } from 'bullmq';

/** BullMQ connection options from a redis:// URL (credentials stay in memory, never logged). */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    // Fail fast on the request path; health checks report the outage instead of hanging.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  };
}
