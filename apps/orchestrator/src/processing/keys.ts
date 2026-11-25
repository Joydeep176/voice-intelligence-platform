import { canonicalJson, storageUriForKey } from '@vip/contracts';
import { createHash } from 'node:crypto';

/** Original recording, as the audio service expects it (`validate_original_key`). */
export const originalKey = (workspaceId: string, recordingId: string): string =>
  `recordings/${workspaceId}/${recordingId}/original`;

/** Output prefix of one config version (`validate_output_prefix`). */
export const outputPrefix = (
  workspaceId: string,
  recordingId: string,
  configHash: string,
): string => `derived/${workspaceId}/${recordingId}/${configHash}`;

export const configHashOf = (config: unknown): string =>
  createHash('sha256').update(canonicalJson(config)).digest('hex');

/**
 * Idempotency key of the n-th submission (1-based). Submission 1 has no suffix. A retry after a
 * failure needs a new key because the service answers a repeated key with the earlier (failed)
 * task. The key stays within the service's 128-character limit (36 + 64 + suffix).
 */
export const idempotencyKey = (
  recordingId: string,
  configHash: string,
  kind: 'preprocess' | 'probe',
  submission: number,
): string =>
  `${recordingId}:${configHash}:${kind}${submission > 1 ? `:${String(submission)}` : ''}`;

/**
 * Storage URI of a key in the same scheme (and bucket) as the recording's own URI. Delegates to the
 * shared helper that mirrors the API's `StorageService.uriFor`, so one place owns the format.
 */
export const uriForKey = storageUriForKey;
