import { ProcessingSnapshot } from '@vip/contracts';
import { request, ws } from '@/lib/api';

/**
 * Audio processing endpoints (API §3a). Declared here, not in `lib/api.ts`, so the schemas load with
 * the recording page instead of the entry bundle. Start/retry and cancel answer with a snapshot.
 */
export const processingApi = {
  get: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/processing`), ProcessingSnapshot, { signal }),
  start: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/processing`), ProcessingSnapshot, { method: 'POST', signal }),
  cancel: (id: string, signal?: AbortSignal) =>
    request(ws(`/recordings/${id}/processing/cancel`), ProcessingSnapshot, {
      method: 'POST',
      signal,
    }),
};
