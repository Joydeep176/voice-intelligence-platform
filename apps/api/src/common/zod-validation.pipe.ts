import { type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppException } from './app-exception';

/** Validates a request part against a contract schema; 422 VALIDATION_FAILED on failure. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new AppException(
      422,
      'VALIDATION_FAILED',
      'Validation failed',
      undefined,
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
}
