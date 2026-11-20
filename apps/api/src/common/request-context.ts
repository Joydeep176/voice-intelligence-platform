import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const REQUEST_ID = Symbol('requestId');
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const logger = new Logger('HTTP');

type WithId = Request & { [REQUEST_ID]?: string };

export function requestIdOf(req: Request): string | undefined {
  return (req as WithId)[REQUEST_ID];
}

/**
 * Assigns a request ID (an incoming `x-request-id` is kept only if it is a safe token) and logs
 * one content-free line per request: method, route pattern, status and duration. No bodies,
 * query strings, filenames or headers are logged (SEC-9).
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  (req as WithId)[REQUEST_ID] = id;
  res.setHeader('x-request-id', id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = (req.route as { path?: string } | undefined)?.path;
    logger.log({
      msg: 'http_request',
      requestId: id,
      method: req.method,
      route: route ? `${req.baseUrl}${route}` : 'unmatched',
      status: res.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
    });
  });
  next();
}
