import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { type ApiError, type ErrorCode, PROBLEM_CONTENT_TYPE } from '@vip/contracts';
import type { Request, Response } from 'express';
import { AppException } from './app-exception';
import { requestIdOf } from './request-context';

const STATUS_CODES: Record<number, ErrorCode> = {
  400: 'MALFORMED_REQUEST',
  404: 'NOT_FOUND',
  409: 'INVALID_STATE_TRANSITION',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  503: 'DEPENDENCY_UNAVAILABLE',
};

const TITLES: Record<number, string> = {
  400: 'Malformed request',
  404: 'Not found',
  413: 'Payload too large',
  415: 'Unsupported media type',
  500: 'Internal server error',
};

interface BodyParserError {
  type?: string;
  status?: number;
}

/** Renders every error as Problem Details. Unknown errors become a generic 500. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const problem = this.toProblem(exception);
    problem.requestId = requestIdOf(req);

    if (problem.status >= 500) {
      // Name, code and stack frames only: messages from drivers may contain data values.
      const err = exception instanceof Error ? exception : undefined;
      this.logger.error({
        msg: 'unhandled_error',
        requestId: problem.requestId,
        errorName: err?.name ?? typeof exception,
        errorCode: (exception as { code?: unknown } | undefined)?.code ?? null,
        frames:
          err?.stack
            ?.split('\n')
            .slice(1, 6)
            .map((l) => l.trim()) ?? [],
      });
    }
    if (res.headersSent) return;
    res.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }

  private toProblem(exception: unknown): ApiError {
    if (exception instanceof AppException) {
      return {
        type: `urn:vip:problem:${exception.code.toLowerCase()}`,
        title: exception.title,
        status: exception.status,
        code: exception.code,
        ...(exception.detail ? { detail: exception.detail } : {}),
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }
    const parserType = (exception as BodyParserError | undefined)?.type;
    if (parserType === 'entity.parse.failed') return this.generic(400, 'MALFORMED_REQUEST');
    if (parserType === 'entity.too.large') return this.generic(413, 'PAYLOAD_TOO_LARGE');
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return this.generic(
        status,
        STATUS_CODES[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'MALFORMED_REQUEST'),
      );
    }
    return this.generic(500, 'INTERNAL_ERROR');
  }

  private generic(status: number, code: ErrorCode): ApiError {
    return {
      type: `urn:vip:problem:${code.toLowerCase()}`,
      title: TITLES[status] ?? (status >= 500 ? 'Internal server error' : 'Request failed'),
      status,
      code,
    };
  }
}
