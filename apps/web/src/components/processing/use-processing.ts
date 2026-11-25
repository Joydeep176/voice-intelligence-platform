import type { ProcessingSnapshot } from '@vip/contracts';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { processingApi } from './api';
import { actionErrorMessage, isActiveState, POLL_MS, type ProcessingAction } from './model';

export type ProcessingLoad =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; snapshot: ProcessingSnapshot };

/**
 * Loads the processing snapshot and polls every `POLL_MS` only while it is validating, queued or
 * processing. Polling pauses while the tab is hidden and resumes (with an immediate refresh) when
 * it is visible again. A failed poll keeps the last snapshot and sets `refreshFailed`.
 */
export function useProcessing(recordingId: string) {
  const [load, setLoad] = useState<ProcessingLoad>({ status: 'loading' });
  const [now, setNow] = useState(() => Date.now());
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState<ProcessingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Bumped whenever an action result is applied, so an older in-flight poll cannot overwrite it.
  const epoch = useRef(0);

  const accept = useCallback((snapshot: ProcessingSnapshot) => {
    setLoad({ status: 'ready', snapshot });
    setNow(Date.now());
    setRefreshFailed(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    processingApi.get(recordingId, controller.signal).then(
      (snapshot) => {
        if (!controller.signal.aborted) accept(snapshot);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setLoad({ status: 'error', error });
      },
    );
    return () => controller.abort();
  }, [recordingId, nonce, accept]);

  const active = load.status === 'ready' && isActiveState(load.snapshot.state);
  const poll = useEffectEvent(async (signal: AbortSignal) => {
    const seen = epoch.current;
    try {
      const snapshot = await processingApi.get(recordingId, signal);
      if (!signal.aborted && seen === epoch.current) accept(snapshot);
    } catch {
      if (!signal.aborted) setRefreshFailed(true);
    }
  });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden && !controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      await poll(controller.signal);
      schedule();
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, recordingId]);

  /** Start/retry (`start`) or cancel. Resolves true when the server accepted the request. */
  const run = useCallback(
    async (action: ProcessingAction) => {
      setBusy(action);
      setActionError(null);
      try {
        const snapshot = await (action === 'start'
          ? processingApi.start(recordingId)
          : processingApi.cancel(recordingId));
        epoch.current += 1;
        accept(snapshot);
        return true;
      } catch (error) {
        setActionError(actionErrorMessage(action, error));
        // The state may have moved on (for example a 409): show what the server now says.
        await processingApi.get(recordingId).then(accept, () => setRefreshFailed(true));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [recordingId, accept],
  );

  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    setNonce((n) => n + 1);
  }, []);
  return { load, now, refreshFailed, busy, actionError, run, reload };
}
