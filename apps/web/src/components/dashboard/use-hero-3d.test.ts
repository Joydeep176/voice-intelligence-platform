import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WIDE = '(min-width: 1024px) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

interface Env {
  wide: boolean;
  reduced: boolean;
  saveData: boolean;
  visible: boolean;
  webgl: boolean;
  readyState: DocumentReadyState;
}

const base: Env = {
  wide: true,
  reduced: false,
  saveData: false,
  visible: true,
  webgl: true,
  readyState: 'complete',
};

class Query {
  listeners = new Set<() => void>();
  constructor(public matches: boolean) {}
  addEventListener = (_: string, fn: () => void) => this.listeners.add(fn);
  removeEventListener = (_: string, fn: () => void) => this.listeners.delete(fn);
  set(value: boolean) {
    this.matches = value;
    this.listeners.forEach((fn) => fn());
  }
}

let queries: Record<string, Query>;
let idle: Array<() => void>;
let loseContext: ReturnType<typeof vi.fn>;
let getContext: ReturnType<typeof vi.fn>;
const originals = {
  matchMedia: window.matchMedia,
  getContext: HTMLCanvasElement.prototype.getContext,
};

function arrange(over: Partial<Env> = {}) {
  const env = { ...base, ...over };
  queries = { [WIDE]: new Query(env.wide), [REDUCED]: new Query(env.reduced) };
  window.matchMedia = ((q: string) =>
    queries[q] ?? new Query(false)) as unknown as typeof window.matchMedia;
  idle = [];
  vi.stubGlobal('requestIdleCallback', (fn: () => void) => idle.push(fn));
  vi.stubGlobal('cancelIdleCallback', () => {});
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value: Object.assign(new EventTarget(), { saveData: env.saveData }),
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (env.visible ? 'visible' : 'hidden'),
  });
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => env.readyState });
  loseContext = vi.fn();
  getContext = vi.fn(() => (env.webgl ? { getExtension: () => ({ loseContext }) } : null));
  HTMLCanvasElement.prototype.getContext = getContext as never;
}

async function mount() {
  vi.resetModules(); // the WebGL probe result is cached per module instance
  const { useHero3d } = await import('./use-hero-3d');
  return renderHook(() => useHero3d());
}

const flushIdle = () => act(() => idle.splice(0).forEach((fn) => fn()));

beforeEach(() => vi.useRealTimers());
afterEach(() => {
  cleanup(); // unmount while the idle-callback stubs still exist
  window.matchMedia = originals.matchMedia;
  HTMLCanvasElement.prototype.getContext = originals.getContext;
  delete (document as unknown as Record<string, unknown>).visibilityState;
  delete (document as unknown as Record<string, unknown>).readyState;
  delete (navigator as unknown as Record<string, unknown>).connection;
  vi.unstubAllGlobals();
});

describe('useHero3d', () => {
  it('is true only when every condition holds, and releases the probe context', async () => {
    arrange();
    const { result } = await mount();
    await flushIdle();
    expect(result.current).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<Env>]>([
    ['a narrow viewport or coarse pointer', { wide: false }],
    ['reduced motion', { reduced: true }],
    ['saveData', { saveData: true }],
    ['a hidden tab', { visible: false }],
    ['no WebGL', { webgl: false }],
  ])('is false for %s', async (_name, over) => {
    arrange(over);
    const { result } = await mount();
    await flushIdle();
    expect(result.current).toBe(false);
  });

  it('is false before idle', async () => {
    arrange();
    const { result } = await mount();
    expect(result.current).toBe(false);
    expect(idle).toHaveLength(1);
    await flushIdle();
    expect(result.current).toBe(true);
  });

  it('waits for the load event when the document is not yet complete', async () => {
    arrange({ readyState: 'loading' });
    const { result } = await mount();
    await flushIdle();
    expect(idle).toHaveLength(0);
    expect(result.current).toBe(false);
    act(() => {
      window.dispatchEvent(new Event('load'));
    });
    expect(idle).toHaveLength(1);
    expect(result.current).toBe(false);
    await flushIdle();
    expect(result.current).toBe(true);
  });

  it('falls back to a 1200 ms timer without requestIdleCallback', async () => {
    arrange();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const { result } = await mount();
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1199);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it('flips back to false when reduced motion turns on, and when the tab hides', async () => {
    arrange();
    const { result } = await mount();
    await flushIdle();
    expect(result.current).toBe(true);
    act(() => queries[REDUCED]!.set(true));
    expect(result.current).toBe(false);
    act(() => queries[REDUCED]!.set(false));
    expect(result.current).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(false);
  });

  it('flips to false when the viewport becomes narrow', async () => {
    arrange();
    const { result } = await mount();
    await flushIdle();
    act(() => queries[WIDE]!.set(false));
    expect(result.current).toBe(false);
  });
});
