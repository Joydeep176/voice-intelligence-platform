import { type ComponentType, useCallback, useRef, useState } from 'react';

/**
 * Loads a component module on first user intent (pointer enter/down, focus, activation). `loader` must
 * be a stable (module-level) function. A failed import is not cached: the next intent retries, and the
 * caller keeps showing its eager fallback in the meantime.
 */
export function useIntentLoad<P extends object>(loader: () => Promise<ComponentType<P>>) {
  const [loaded, setLoaded] = useState<{ Component: ComponentType<P> } | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const load = useCallback(() => {
    pending.current ??= loader()
      .then((Component) => setLoaded({ Component }))
      .catch(() => {
        pending.current = null;
      });
  }, [loader]);
  return { Component: loaded?.Component ?? null, load };
}
