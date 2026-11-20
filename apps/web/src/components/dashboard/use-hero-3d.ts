import { useEffect, useState } from 'react';

let webglProbe: boolean | undefined;

/** One-time WebGL probe; the probe context is released immediately. */
function hasWebGL(): boolean {
  if (webglProbe !== undefined) return webglProbe;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') || canvas.getContext('webgl')) as
      WebGL2RenderingContext | WebGLRenderingContext | null;
    webglProbe = gl !== null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglProbe = false;
  }
  return webglProbe;
}

type NetworkInformationLike = EventTarget & { saveData?: boolean };
const connection = () =>
  (navigator as Navigator & { connection?: NetworkInformationLike }).connection;

/**
 * True only for a capable, motion-tolerant desktop: wide viewport with a fine pointer, no reduced
 * motion, no data saver, visible tab and WebGL. Checked after first paint and idle time, then kept
 * up to date as conditions change (3d-optional.md).
 */
export function useHero3d(): boolean {
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const wide = matchMedia('(min-width: 1024px) and (pointer: fine)');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const conn = connection();
    let listening = false;

    const evaluate = () =>
      setEligible(
        wide.matches &&
          !reduced.matches &&
          !conn?.saveData &&
          document.visibilityState === 'visible' &&
          hasWebGL(),
      );
    const start = () => {
      listening = true;
      evaluate();
      wide.addEventListener('change', evaluate);
      reduced.addEventListener('change', evaluate);
      conn?.addEventListener('change', evaluate);
      document.addEventListener('visibilitychange', evaluate);
    };

    let idleId: number | undefined;
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (typeof requestIdleCallback === 'function')
        idleId = requestIdleCallback(start, { timeout: 2000 }); // never postponed indefinitely
      else timerId = setTimeout(start, 1200);
    };
    // Wait for the window load event so the 3D upgrade never competes with page load work.
    const onLoad = () => schedule();
    if (document.readyState === 'complete') schedule();
    else window.addEventListener('load', onLoad, { once: true });

    return () => {
      window.removeEventListener('load', onLoad);
      if (idleId !== undefined) cancelIdleCallback(idleId);
      clearTimeout(timerId);
      if (listening) {
        wide.removeEventListener('change', evaluate);
        reduced.removeEventListener('change', evaluate);
        conn?.removeEventListener('change', evaluate);
        document.removeEventListener('visibilitychange', evaluate);
      }
    };
  }, []);

  return eligible;
}
