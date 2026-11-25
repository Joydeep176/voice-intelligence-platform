import {
  RunSnapshot,
  SpeakerDto,
  SpeakerList,
  TranscriptPage,
  TranscriptVersionList,
  UncertaintyList,
} from '@vip/contracts';
import { request, ws } from '@/lib/api';

/**
 * Transcription endpoints (API §3 and §5). Declared here, not in `lib/api.ts`, so the schemas load
 * with the recording page chunk instead of the entry bundle. Responses are never cached by the API.
 */
const post = (body?: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  signal,
});

export interface PageQuery {
  version?: number | null;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string | null;
}

function query(q: PageQuery): string {
  const params = new URLSearchParams();
  if (q.version != null) params.set('version', String(q.version));
  if (q.fromMs !== undefined) params.set('fromMs', String(q.fromMs));
  if (q.toMs !== undefined) params.set('toMs', String(q.toMs));
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.cursor) params.set('cursor', q.cursor);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export const transcriptionApi = {
  getRun: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}`), RunSnapshot, { signal }),
  start: (recordingId: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${recordingId}/runs`), RunSnapshot, post({}, signal)),
  cancel: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/cancel`), RunSnapshot, post(undefined, signal)),
  retry: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/retry`), RunSnapshot, post(undefined, signal)),
  versions: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/transcript/versions`), TranscriptVersionList, { signal }),
  transcript: (runId: string, q: PageQuery, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/transcript${query(q)}`), TranscriptPage, { signal }),
  uncertainties: (runId: string, q: PageQuery, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/transcript/uncertainties${query(q)}`), UncertaintyList, { signal }),
  speakers: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/speakers`), SpeakerList, { signal }),
  renameSpeaker: (runId: string, speakerId: string, displayName: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/speakers/${speakerId}`), SpeakerDto, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName }),
      signal,
    }),
};
