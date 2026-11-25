import type { RunSnapshot } from '@vip/contracts';
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { transcriptionApi } from './api';
import { actionErrorMessage, isActiveRun, POLL_MS, type RunAction } from './model';

type Fetched =
  | { status: 'loading' }
  | { status: 'error'; runId: string; error: unknown }
  | { status: 'ready'; snapshot: RunSnapshot };

export type RunLoad =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; snapshot: RunSnapshot };

/**
 * Loads the run snapshot and polls every `POLL_MS` only while it is queued, running or cancelling.
 * Polling pauses while the tab is hidden and resumes (with an immediate refresh) when visible.
 * A failed poll keeps the last snapshot and sets `refreshFailed`. `latestRunId` is the run the
 * recording already has (null = none); starting makes the API return the run to follow.
 */
export function useRun(recordingId: string, latestRunId: string | null) {
  const [startedId, setStartedId] = useState<string | null>(null);
  const runId = startedId ?? latestRunId;
  const [fetched, setFetched] = useState<Fetched>({ status: 'loading' });
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState<RunAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Bumped when an action result is applied, so an older in-flight poll cannot overwrite it.
  const epoch = useRef(0);

  const accept = useCallback((snapshot: RunSnapshot) => {
    setFetched({ status: 'ready', snapshot });
    setRefreshFailed(false);
  }, []);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    transcriptionApi.getRun(runId, controller.signal).then(
      (snapshot) => {
        if (!controller.signal.aborted) accept(snapshot);
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setFetched({ status: 'error', runId, error });
      },
    );
    return () => controller.abort();
  }, [runId, nonce, accept]);

  // Derived, so a snapshot or error that belongs to another run is never shown.
  const load: RunLoad = !runId
    ? { status: 'none' }
    : fetched.status === 'ready' && fetched.snapshot.id === runId
      ? fetched
      : fetched.status === 'error' && fetched.runId === runId
        ? { status: 'error', error: fetched.error }
        : { status: 'loading' };

  const active = load.status === 'ready' && isActiveRun(load.snapshot);
  const poll = useEffectEvent(async (id: string, signal: AbortSignal) => {
    const seen = epoch.current;
    try {
      const snapshot = await transcriptionApi.getRun(id, signal);
      if (!signal.aborted && seen === epoch.current) accept(snapshot);
    } catch {
      if (!signal.aborted) setRefreshFailed(true);
    }
  });

  useEffect(() => {
    if (!active || !runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (!document.hidden && !controller.signal.aborted) timer = setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      await poll(runId, controller.signal);
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
  }, [active, runId]);

  /** Resolves true when the server accepted the request. */
  const act = useCallback(
    async (action: RunAction) => {
      setBusy(action);
      setActionError(null);
      try {
        const snapshot = await (action === 'start'
          ? transcriptionApi.start(recordingId)
          : action === 'cancel'
            ? transcriptionApi.cancel(runId ?? '')
            : transcriptionApi.retry(runId ?? ''));
        epoch.current += 1;
        setStartedId(snapshot.id);
        accept(snapshot);
        return true;
      } catch (error) {
        setActionError(actionErrorMessage(action, error));
        // The state may have moved on (for example a 409): show what the server now says.
        if (runId) await transcriptionApi.getRun(runId).then(accept, () => setRefreshFailed(true));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [recordingId, runId, accept],
  );

  const reload = useCallback(() => {
    setFetched({ status: 'loading' });
    setNonce((n) => n + 1);
  }, []);
  return { load, refreshFailed, busy, actionError, act, reload };
}
