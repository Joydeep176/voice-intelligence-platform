import type { AudioDiagnosticsSnapshot } from '@vip/contracts';
import { useCallback, useEffect, useState } from 'react';
import { POLL_MS } from '../transcription/model';
import { audioQualityApi } from './api';
import { isActiveDiagnostics } from './model';

export type DiagnosticsLoad =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; snapshot: AudioDiagnosticsSnapshot };

/**
 * Loads the run's audio diagnostics and polls every `POLL_MS` while the assessment is pending or
 * running (and while the tab is visible). `retry` asks for an A1-only re-assessment (L6).
 */
export function useAudioDiagnostics(runId: string | null) {
  const [fetched, setFetched] = useState<{ runId: string; load: DiagnosticsLoad } | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(false);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    audioQualityApi.get(runId, controller.signal).then(
      (snapshot) => {
        if (!controller.signal.aborted && snapshot.runId === runId)
          setFetched({ runId, load: { status: 'ready', snapshot } });
      },
      () => {
        if (!controller.signal.aborted)
          setFetched((prev) =>
            prev?.runId === runId && prev.load.status === 'ready'
              ? prev
              : { runId, load: { status: 'error' } },
          );
      },
    );
    return () => controller.abort();
  }, [runId, nonce]);

  // Derived, so a result that belongs to another run is never shown.
  const load: DiagnosticsLoad = !runId
    ? { status: 'none' }
    : fetched?.runId === runId
      ? fetched.load
      : { status: 'loading' };

  const active = load.status === 'ready' && isActiveDiagnostics(load.snapshot.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setNonce((n) => n + 1);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [active]);

  const retry = useCallback(async () => {
    if (!runId) return;
    setBusy(true);
    setActionError(false);
    try {
      setFetched({
        runId,
        load: { status: 'ready', snapshot: await audioQualityApi.retry(runId) },
      });
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }, [runId]);

  return { load, retry, busy, actionError, refresh: () => setNonce((n) => n + 1) };
}
