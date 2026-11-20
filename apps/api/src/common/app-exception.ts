import type { ErrorCode } from '@vip/contracts';

export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * Domain error rendered as RFC 9457 Problem Details. `detail` must be a fixed, content-free
 * message: never interpolate filenames, transcript text or provider output (SEC-9).
 */
export class AppException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: FieldIssue[],
  ) {
    super(title);
    this.name = 'AppException';
  }

  static notFound(resource = 'Resource'): AppException {
    return new AppException(404, 'NOT_FOUND', `${resource} not found`);
  }
}
