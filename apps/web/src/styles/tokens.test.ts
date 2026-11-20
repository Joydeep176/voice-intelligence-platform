/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';

/**
 * WCAG AA contrast for the design tokens in both themes (ADR-0030, accessibility.md).
 * Parses src/index.css, converts OKLCH to sRGB and checks every text-on-surface pair the UI uses.
 */
// Vitest runs from apps/web (its config root).
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

type Rgb = [number, number, number];

function tokens(selector: ':root' | '.dark'): Record<string, string> {
  const out: Record<string, string> = {};
  const blocks = css.matchAll(
    new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`, 'g'),
  );
  for (const [, body] of blocks) {
    for (const [, name, value] of body!.matchAll(/--([\w-]+):\s*([^;]+);/g))
      out[name!] = value!.trim();
  }
  return out;
}

function oklchToRgb(value: string): Rgb {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not an opaque oklch() colour: ${value}`);
  const [l, c, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin: Rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((x) => Math.min(1, Math.max(0, x))) as Rgb; // linear sRGB, gamut-clipped
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (top: Rgb, bottom: Rgb, alpha: number): Rgb =>
  top.map((v, i) => v * alpha + bottom[i]! * (1 - alpha)) as Rgb; // approximate (linear space)
function ratio(fg: Rgb, bg: Rgb) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// [foreground token, background token, foreground opacity, background tint of the fg colour]
type Pair = [string, string, number?, number?];
const TEXT_PAIRS: Pair[] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['primary', 'background'],
  ['primary', 'card'],
  ['secondary-foreground', 'secondary'],
  ['accent-foreground', 'accent'],
  ['destructive', 'card'],
  ['destructive', 'card', 0.9], // alert description: text-destructive/90
  ['destructive', 'card', 1, 0.1], // destructive badge/button: text on destructive/10 tint
  ['sidebar-foreground', 'sidebar'],
  ['muted-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['success', 'success-soft'],
  ['warning', 'warning-soft'],
  ['info', 'info-soft'],
  ['warning', 'background'],
  ['provenance-recorded', 'card'],
  ['provenance-external', 'card'],
  ['provenance-inferred', 'card'],
];

describe.each([':root', '.dark'] as const)('design tokens (%s)', (selector) => {
  const t = tokens(selector);
  const rgb = (name: string) => {
    const v = t[name];
    if (!v) throw new Error(`missing token --${name} in ${selector}`);
    return oklchToRgb(v);
  };

  it.each(TEXT_PAIRS.map(([fg, bg, opacity = 1, tint = 0]) => [fg, bg, opacity, tint] as const))(
    '%s on %s (text opacity %s, %s tint) meets WCAG AA (4.5:1)',
    (fg, bg, opacity, tint) => {
      const base = tint ? mix(rgb(fg), rgb(bg), tint) : rgb(bg);
      const text = opacity < 1 ? mix(rgb(fg), base, opacity) : rgb(fg);
      expect(ratio(text, base)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('keeps audio diagnostics and transcription uncertainty as separate token families', () => {
    for (const level of ['low', 'medium', 'high']) {
      expect(t[`diag-${level}`]).toBeDefined();
      expect(t[`uncert-${level}`]).toBeDefined();
      expect(t[`diag-${level}`]).not.toBe(t[`uncert-${level}`]);
    }
  });
});
