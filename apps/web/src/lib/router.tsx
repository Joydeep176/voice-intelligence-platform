import { type AnchorHTMLAttributes, type MouseEvent, useSyncExternalStore } from 'react';

/**
 * Minimal history router. A routing library is not part of the approved frontend stack,
 * and the app has only a handful of routes.
 */
export type Route =
  | { name: 'dashboard' }
  | { name: 'recordings' }
  | { name: 'upload' }
  | { name: 'recording'; id: string }
  | { name: 'not-found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'dashboard' };
  if (path === '/recordings') return { name: 'recordings' };
  if (path === '/recordings/new') return { name: 'upload' };
  const m = /^\/recordings\/([^/]+)$/.exec(path);
  if (m?.[1] && UUID.test(m[1])) return { name: 'recording', id: m[1] };
  return { name: 'not-found' };
}

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('popstate', fn);
  };
};

export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  listeners.forEach((fn) => fn());
  window.scrollTo?.({ top: 0 });
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function useRoute(): Route {
  return matchRoute(usePathname());
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
