import { z } from 'zod';
import { IsoDateTime, Uuid, paginated } from './common.js';
import { ProcessingStatus } from './runs.js';

/** DATABASE_DESIGN §4 `recordings.status`. */
export const RECORDING_STATUSES = [
  'uploading',
  'uploaded',
  'validating',
  'valid',
  'invalid',
  'deleting',
] as const;
export const RecordingStatus = z.enum(RECORDING_STATUSES);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

/**
 * Interim development defaults. Real limits are OD-10 (Open); the API enforces its
 * configured values, which may be narrower.
 */
export const SUPPORTED_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/flac',
  'audio/ogg',
  'audio/webm',
] as const;
export const AudioMimeType = z.enum(SUPPORTED_AUDIO_MIME_TYPES);
export type AudioMimeType = z.infer<typeof AudioMimeType>;

/**
 * Consent attestation (SEC-1). The statement wording and legal basis for production are
 * OD-09b (Open); this version identifies the interim development statement (ADR-0004).
 */
export const DEV_CONSENT_STATEMENT_VERSION = 'dev-2026-11';
export const DEV_CONSENT_STATEMENT =
  'I confirm this recording is synthetic, or that every speaker has explicitly consented to its use for development and testing.';

export const ConsentAttestationInput = z.object({
  statementVersion: z.string().min(1).max(64),
  attested: z.literal(true),
});

/** Rejects control characters and path separators; the filename is metadata only. */
function isSafeFilename(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '/' || char === '\\') return false;
  }
  return true;
}

/** `POST /recordings` body (API §2). */
export const CreateRecordingRequest = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(isSafeFilename, 'Filename contains invalid characters'),
  mimeType: AudioMimeType,
  sizeBytes: z.number().int().positive(),
  consent: ConsentAttestationInput,
});
export type CreateRecordingRequest = z.infer<typeof CreateRecordingRequest>;

/** DATABASE_DESIGN §4 `upload_sessions` (local chunked strategy in development). */
export const UploadSession = z.object({
  strategy: z.enum(['local_chunked', 's3_multipart']),
  status: z.enum(['active', 'completed', 'expired', 'aborted']),
  partSize: z.number().int().positive(),
  totalParts: z.number().int().positive(),
  partsReceived: z.array(
    z.object({ partNumber: z.number().int().positive(), sizeBytes: z.number().int().positive() }),
  ),
  expiresAt: IsoDateTime,
});
export type UploadSession = z.infer<typeof UploadSession>;

/** Recording metadata as exposed by the API. Storage keys and paths are never exposed. */
export const RecordingMetadata = z.object({
  id: Uuid,
  workspaceId: Uuid,
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Null until determined by the audio service (later phase). */
  durationMs: z.number().int().nonnegative().nullable(),
  sha256: z.string().length(64).nullable(),
  status: RecordingStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  latestRun: ProcessingStatus.nullable(),
});
export type RecordingMetadata = z.infer<typeof RecordingMetadata>;

/** `POST /recordings` response: the recording plus its upload session. */
export const RecordingUploadResponse = z.object({
  recording: RecordingMetadata,
  upload: UploadSession,
});
export type RecordingUploadResponse = z.infer<typeof RecordingUploadResponse>;

/** `PUT /recordings/{id}/upload/parts/{n}` response. */
export const UploadPartResponse = z.object({
  partNumber: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
});
export type UploadPartResponse = z.infer<typeof UploadPartResponse>;

export const RecordingList = paginated(RecordingMetadata);
export type RecordingList = z.infer<typeof RecordingList>;
