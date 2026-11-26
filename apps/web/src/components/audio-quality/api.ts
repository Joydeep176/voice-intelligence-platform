import { AudioDiagnosticsSnapshot } from '@vip/contracts';
import { request, ws } from '@/lib/api';

/** Audio diagnostics (API §4, ADR-0044). Loaded with the recording page chunk. Never cached. */
export const audioQualityApi = {
  get: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/audio-diagnostics`), AudioDiagnosticsSnapshot, { signal }),
  retry: (runId: string, signal?: AbortSignal) =>
    request(ws(`/runs/${runId}/audio-diagnostics/retry`), AudioDiagnosticsSnapshot, {
      method: 'POST',
      signal,
    }),
};
