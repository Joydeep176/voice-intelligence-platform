import { type ApiError, PROBLEM_CONTENT_TYPE } from '@vip/contracts';
import type { NextFunction, Request, Response } from 'express';
import { requestIdOf } from './request-context';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Hostname of a `Host` header value, lower-cased, port stripped. Null when absent or empty. */
export function hostnameOf(header: string | undefined): string | null {
  const value = header?.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? null : value.slice(0, end + 1);
  }
  const colons = value.split(':').length - 1;
  if (colons > 1) return value; // bare IPv6 without brackets, no port
  return value.split(':')[0] || null;
}

export function isLoopbackHost(header: string | undefined): boolean {
  const name = hostnameOf(header);
  return name !== null && LOOPBACK_NAMES.has(name);
}

/**
 * Development-only DNS-rebinding defence (SEC-01). Authentication is off in `AUTH_MODE=dev`, so
 * a page that rebinds its hostname to loopback could otherwise call the API same-origin. Only
 * loopback `Host` names are served; the port is ignored because the Vite proxies forward the
 * browser's host (e.g. `localhost:5173`). The response never echoes the rejected host.
 */
export function devHostGuard(req: Request, res: Response, next: NextFunction): void {
  if (isLoopbackHost(req.headers.host)) {
    next();
    return;
  }
  const requestId = requestIdOf(req);
  const problem: ApiError = {
    type: 'urn:vip:problem:host_not_allowed',
    title: 'Host not allowed',
    status: 403,
    code: 'HOST_NOT_ALLOWED',
    ...(requestId ? { requestId } : {}),
  };
  res.status(403).type(PROBLEM_CONTENT_TYPE).json(problem);
}
