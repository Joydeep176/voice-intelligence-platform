import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeroPalette, HeroSceneHandle } from '@/components/hero-3d/hero-scene';
import { useHero3d } from './use-hero-3d';

function readPalette(): HeroPalette {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string) => css.getPropertyValue(name).trim();
  return {
    indigo: get('--brand-indigo'),
    violet: get('--brand-violet'),
    blue: get('--brand-blue'),
    cyan: get('--brand-cyan'),
    foreground: get('--foreground'),
    background: get('--background'),
  };
}

function SceneCanvas({
  onReady,
  onFail,
}: {
  onReady: (ready: boolean) => void;
  onFail: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const host = wrap?.parentElement;
    if (!wrap || !host) return;
    // A fresh canvas per mount: dispose() does not force context loss, so a canvas is never reused.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.className =
      'absolute inset-0 size-full opacity-0 transition-opacity duration-700 motion-reduce:transition-none';
    wrap.appendChild(canvas);
    let disposed = false;
    let handle: HeroSceneHandle | undefined;
    const cleanups: Array<() => void> = [];

    // The scene (and three.js) is a separate chunk, fetched only once eligibility is confirmed.
    import('@/components/hero-3d/hero-scene')
      .then(({ mountHeroScene }) => {
        if (disposed) return;
        // onFirstFrame can run before mountHeroScene returns, so it must not use the handle.
        const scene = mountHeroScene(canvas, {
          palette: readPalette(),
          onContextLost: onFail,
          onFirstFrame: () => {
            canvas.classList.replace('opacity-0', 'opacity-100');
            onReady(true);
          },
        });
        handle = scene;

        const ro = new ResizeObserver((entries) => {
          const rect = entries[0]?.contentRect;
          if (rect)
            scene.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
        });
        ro.observe(host);
        const io = new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (entry) scene.setActive(entry.isIntersecting);
        });
        io.observe(host);
        const theme = new MutationObserver(() => scene.setPalette(readPalette()));
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        const move = (e: PointerEvent) => {
          const r = host.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          const clamp = (v: number) => Math.max(-1, Math.min(1, v));
          scene.setPointer(
            clamp(((e.clientX - r.left) / r.width) * 2 - 1),
            clamp(((e.clientY - r.top) / r.height) * 2 - 1),
          );
        };
        const leave = () => scene.setPointer(0, 0);
        host.addEventListener('pointermove', move);
        host.addEventListener('pointerleave', leave);
        cleanups.push(
          () => ro.disconnect(),
          () => io.disconnect(),
          () => theme.disconnect(),
          () => host.removeEventListener('pointermove', move),
          () => host.removeEventListener('pointerleave', leave),
        );
      })
      .catch(() => {
        if (!disposed) onFail();
      });

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      handle?.dispose();
      canvas.remove();
      onReady(false);
    };
  }, [onReady, onFail]);

  return <div ref={wrapRef} aria-hidden className="absolute inset-0" />;
}

/**
 * Optional WebGL layer above the static SVG. Renders nothing (the 2D visual is the complete
 * experience) unless eligible, and falls back to 2D on import failure or context loss.
 */
export function HeroCanvas({ onReady }: { onReady: (ready: boolean) => void }) {
  const eligible = useHero3d();
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  if (!eligible || failed) return null;
  return <SceneCanvas onReady={onReady} onFail={fail} />;
}
