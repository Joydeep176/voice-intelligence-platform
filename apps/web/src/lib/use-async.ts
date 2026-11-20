import { useCallback, useEffect, useEffectEvent, useState } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'success'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

/**
 * Loads data with abort-on-unmount. `pollMs` refreshes in the background without
 * flashing back to the loading state.
 */
export function useAsync<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  pollMs?: number,
) {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const runLoad = useEffectEvent((signal: AbortSignal) => load(signal));

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (background: boolean) => {
      if (!background) setState({ status: 'loading' });
      try {
        const data = await runLoad(controller.signal);
        if (!controller.signal.aborted) setState({ status: 'success', data });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!background) setState({ status: 'error', error });
      }
      if (pollMs && !controller.signal.aborted) timer = setTimeout(() => void run(true), pollMs);
    };
    void run(false);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, pollMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
