import { z } from 'zod';

/**
 * Stable error codes carried in RFC 9457 Problem Details (API §1).
 * Messages never echo transcript or audio content (SEC-9).
 */
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'MALFORMED_REQUEST',
  'CONSENT_REQUIRED',
  'NOT_FOUND',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'UPLOAD_PART_INVALID',
  'UPLOAD_INCOMPLETE',
  'UPLOAD_EXPIRED',
  'MEDIA_SIGNATURE_MISMATCH',
  'INVALID_STATE_TRANSITION',
  'CONTRACT_VERSION_MISMATCH',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
  'HOST_NOT_ALLOWED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FieldError = z.object({
  path: z.string(),
  message: z.string(),
});

/** RFC 9457 Problem Details with a stable `code`. Named `ApiError` in the codebase. */
export const ApiError = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(FieldError).optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
