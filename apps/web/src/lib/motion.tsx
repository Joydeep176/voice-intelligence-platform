import { LazyMotion, MotionConfig, useReducedMotion } from 'motion/react';
import * as m from 'motion/react-m';
import type { ReactNode } from 'react';

// Set once Motion's deferred feature bundle has loaded. Until then (first render, slow network or a
// failed chunk) nothing starts hidden, so content never waits for deferred code.
let featuresReady = false;
const loadFeatures = () =>
  import('./motion-features').then((mod) => {
    featuresReady = true;
    return mod.default;
  });

/** Durations and easing mirror the CSS motion tokens in index.css (motion.md). */
export const MOTION = {
  fast: 0.12,
  base: 0.2,
  ease: [0.2, 0, 0, 1] as const,
};

/**
 * App-wide Motion setup (ADR-0026): `m` components only (`strict`), animation features loaded
 * after first render, and movement disabled for users who prefer reduced motion.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig reducedMotion="user" transition={{ duration: MOTION.base, ease: MOTION.ease }}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

/**
 * Short enter transition when the route changes. Explains the change; never delays input or hides
 * content: the first page, and any page shown before the features load, renders immediately.
 */
export function PageTransition({ routeKey, children }: { routeKey: string; children: ReactNode }) {
  // With reduced motion the page only fades: no initial offset, so nothing jumps either.
  const reduce = useReducedMotion();
  const initial = featuresReady ? { opacity: 0, y: reduce ? 0 : 6 } : false;
  return (
    <m.div key={routeKey} initial={initial} animate={{ opacity: 1, y: 0 }}>
      {children}
    </m.div>
  );
}
