import {
  ApiError,
  HealthResponse,
  ProcessingStatus,
  RecordingList,
  RecordingMetadata,
  RecordingUploadResponse,
  UploadPartResponse,
  UploadSession,
  type CreateRecordingRequest,
} from '@vip/contracts';
import type { z } from 'zod';
import { WORKSPACE_ID } from './config';

/** A failed API call. `problem` is the parsed RFC 9457 body when the server sent one. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ApiError | null,
  ) {
    super(problem?.title ?? `Request failed (${status})`);
    this.name = 'ApiRequestError';
  }

  get code(): string {
    return this.problem?.code ?? (this.status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN');
  }
}

const ws = (path: string) => `/api/v1/workspaces/${WORKSPACE_ID}${path}`;

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.infer<T>> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: 'application/json', ...init?.headers } });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiRequestError(0, null);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const problem = ApiError.safeParse(body);
    throw new ApiRequestError(res.status, problem.success ? problem.data : null);
  }
  // Responses are validated against the shared contracts before the UI uses them.
  return schema.parse(body);
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: (signal?: AbortSignal) => request('/api/v1/health', HealthResponse, { signal }),
  listRecordings: (
    params: { limit?: number; cursor?: string | null } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams({ limit: String(params.limit ?? 25) });
    if (params.cursor) q.set('cursor', params.cursor);
    return request(ws(`/recordings?${q}`), RecordingList, { signal });
  },
  getRecording: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}`), RecordingMetadata, { signal }),
  getRun: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}`), ProcessingStatus, { signal }),
  createRecording: (body: CreateRecordingRequest, signal?: AbortSignal) =>
    request(ws('/recordings'), RecordingUploadResponse, { ...json(body), signal }),
  getUploadSession: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/upload`), UploadSession, { signal }),
  uploadPart: (id: string, partNumber: number, body: Blob, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/upload/parts/${partNumber}`), UploadPartResponse, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body,
      signal,
    }),
  completeUpload: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/upload/complete`), RecordingMetadata, { method: 'POST', signal }),
};

const FRIENDLY: Record<string, string> = {
  CONSENT_REQUIRED: 'Please confirm the consent statement before uploading.',
  PAYLOAD_TOO_LARGE: 'This file is larger than the allowed upload size.',
  VALIDATION_FAILED: 'Some details were not accepted. Check the file and try again.',
  UNSUPPORTED_MEDIA_TYPE: 'This file type is not supported.',
  MEDIA_SIGNATURE_MISMATCH: 'The file content does not match its audio format, so it was rejected.',
  UPLOAD_INCOMPLETE: 'The upload did not finish. Try again to resume it.',
  UPLOAD_EXPIRED: 'The upload session expired. Start the upload again.',
  UPLOAD_PART_INVALID: 'Part of the upload was not accepted. Try again.',
  NOT_FOUND: 'We could not find that item.',
  NETWORK_ERROR: 'Cannot reach the API. Check that it is running and try again.',
};

/** User-facing message: fixed copy per error code, never server-provided free text. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return (
      FRIENDLY[error.code] ??
      (error.status >= 500 ? 'The server had a problem. Try again shortly.' : 'The request failed.')
    );
  }
  return 'Something went wrong. Try again.';
}
