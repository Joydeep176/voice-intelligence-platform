import { useState } from 'react';
import { HeroCanvas } from './hero-canvas';

/** Deterministic waveform shape: a decorative voice signature, not data. */
const BARS = Array.from({ length: 34 }, (_, i) => {
  const t = i / 33;
  const env = Math.sin(Math.PI * t) ** 1.2;
  const h = 8 + 60 * env * (0.55 + 0.45 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37)));
  return { x: 34 + i * 5.6, h };
});

const NODES = [
  { x: 292, y: 206, label: 'Audio', color: 'var(--brand-blue)' },
  { x: 362, y: 148, label: 'Context', color: 'var(--brand-indigo)' },
  { x: 432, y: 200, label: 'Evidence', color: 'var(--brand-violet)' },
];

function Visual2D({ hidden }: { hidden: boolean }) {
  return (
    <svg
      viewBox="0 0 480 360"
      aria-hidden
      focusable="false"
      className={`absolute inset-0 size-full scale-[1.3] transition-opacity duration-700 motion-reduce:transition-none sm:scale-100 ${hidden ? 'opacity-0' : 'opacity-100'}`}
    >
      <g fill="none" stroke="var(--brand-indigo)" strokeWidth="1">
        {[150, 118, 86, 54].map((r, i) => (
          <circle key={r} cx="240" cy="180" r={r} opacity={0.1 + i * 0.05} />
        ))}
      </g>
      <g stroke="var(--brand-violet)" strokeWidth="3" strokeLinecap="round" opacity="0.85">
        {BARS.map((b) => (
          <line key={b.x} x1={b.x} x2={b.x} y1={180 - b.h / 2} y2={180 + b.h / 2} />
        ))}
      </g>
      <g fill="none" stroke="var(--brand-blue)" strokeWidth="1.5" opacity="0.7">
        <path d="M226 180 C 250 180, 262 206, 292 206" />
        <path d="M292 206 L 362 148 L 432 200" />
      </g>
      {NODES.map((n) => (
        <g key={n.label}>
          <circle cx={n.x} cy={n.y} r="16" fill={n.color} opacity="0.16" />
          <circle cx={n.x} cy={n.y} r="7" fill={n.color} />
          <text
            x={n.x}
            y={n.y + 34}
            textAnchor="middle"
            fontSize="13"
            fill="currentColor"
            opacity="0.7"
            className="font-sans"
          >
            {n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Fixed-aspect visual: the 2D SVG is always present; the WebGL scene fades in above it on capable desktops. */
export function HeroVisual() {
  const [sceneReady, setSceneReady] = useState(false);
  return (
    <div className="text-muted-foreground relative aspect-[16/9] w-full overflow-hidden sm:aspect-[4/3] sm:overflow-visible">
      <Visual2D hidden={sceneReady} />
      <HeroCanvas onReady={setSceneReady} />
    </div>
  );
}
