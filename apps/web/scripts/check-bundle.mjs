// Phase 2A bundle budgets (docs/design/phase2a-m0-baseline/README.md §5).
// Run after `pnpm --filter @vip/web build`:  pnpm --filter @vip/web check:bundle
// Reads dist/.vite/manifest.json and dist/index.html; exits non-zero when a budget is exceeded.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const KB = 1024;
// Amended 2026-11-20 (user decision, M6): combined 190→205, route chunk 25→30. Render-critical (175) and
// deferred Motion (20) still cap combined at 195 in practice.
const BUDGET = {
  // JavaScript, gzip, worst page route. Render-critical = needed for the first render:
  // entry + chunks it statically imports + the route chunk and its static imports.
  renderCriticalJs: 175 * KB,
  // Deferred = Motion's animation features only, fetched asynchronously after first render.
  deferredMotionJs: 20 * KB,
  combinedJs: 205 * KB, // render-critical + deferred Motion for the same route
  interactionChunk: 30 * KB, // each interaction-only chunk, beyond already-loaded code (gzip)
  routeChunk: 30 * KB, // each lazily loaded route chunk (gzip)
  css: 20 * KB, // all CSS (gzip)
  preloadedFonts: { count: 2, bytes: 80 * KB },
  allFonts: 200 * KB,
  threeD: 250 * KB, // lazy dashboard hero scene incl. three.js, beyond already-loaded code (gzip)
};

const dist = resolve(import.meta.dirname, '..', 'dist');
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'));
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const gz = (file) => gzipSync(readFileSync(join(dist, file))).length;
const fmt = (b) => `${(b / KB).toFixed(1)} KB`;

/** A chunk plus everything it statically imports. */
function closure(key, seen = new Set()) {
  if (seen.has(key)) return seen;
  seen.add(key);
  for (const dep of manifest[key].imports ?? []) closure(dep, seen);
  return seen;
}
const jsBytes = (keys) => [...keys].reduce((sum, k) => sum + gz(manifest[k].file), 0);

const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
const base = closure(entryKey);
const rows = [];
const check = (name, actual, limit, { expectExactly = false } = {}) =>
  rows.push({
    name,
    actual,
    limit,
    expectExactly,
    ok: expectExactly ? actual === limit : actual <= limit,
  });

// Page routes are the lazily loaded src/pages/* chunks. Every other dynamic import of the entry must be
// classified: Motion features (fetched after first render) or an interaction-only chunk (fetched on first
// user intent, never after first render and excluded from initial load and combined route JS).
const MOTION_FEATURES = 'src/lib/motion-features.ts';
const INTERACTION_CHUNKS = [
  'src/components/shell/theme-menu.tsx',
  'src/components/shell/mobile-nav-sheet.tsx',
];
const dynamic = manifest[entryKey].dynamicImports ?? [];
const nonPage = dynamic.filter((k) => !k.startsWith('src/pages/'));
const unclassified = nonPage.filter(
  (k) => k !== MOTION_FEATURES && !INTERACTION_CHUNKS.includes(k),
);
const deferredKeys = closure(MOTION_FEATURES);
for (const k of base) deferredKeys.delete(k); // already counted as render-critical

check(
  `Motion features load asynchronously (${MOTION_FEATURES} is a deferred chunk)`,
  nonPage.includes(MOTION_FEATURES) && !base.has(MOTION_FEATURES) ? 1 : 0,
  1,
  { expectExactly: true },
);
check(
  `No unclassified deferred chunks${unclassified.length ? `: ${unclassified.join(', ')}` : ''}`,
  unclassified.length,
  0,
  { expectExactly: true },
);

const routes = dynamic
  .filter((k) => k.startsWith('src/pages/'))
  .map((key) => {
    const critical = closure(key, new Set(base));
    const combined = new Set([...critical, ...deferredKeys]);
    return {
      key,
      critical: jsBytes(critical),
      combined: jsBytes(combined),
      own: gz(manifest[key].file),
    };
  });
const maxBy = (field) => routes.reduce((a, b) => (b[field] > a[field] ? b : a));
const heaviestCritical = maxBy('critical');
const heaviestCombined = maxBy('combined');

check(
  `Render-critical JS: entry + shared + route (${heaviestCritical.key})`,
  heaviestCritical.critical,
  BUDGET.renderCriticalJs,
);
check(
  `Deferred JS after first render: Motion features (${MOTION_FEATURES})`,
  jsBytes(deferredKeys),
  BUDGET.deferredMotionJs,
);
check(
  `Combined route JS: render-critical + deferred Motion (${heaviestCombined.key})`,
  heaviestCombined.combined,
  BUDGET.combinedJs,
);
for (const r of routes) check(`Route chunk ${r.key}`, r.own, BUDGET.routeChunk);

// 3D hero (ADR-0031/0032): must be a lazy chunk, never in a render-critical closure, and within budget.
const HERO_SCENE = 'src/components/hero-3d/hero-scene.ts';
const heroInManifest = HERO_SCENE in manifest;
const heroDynamicallyImported = Object.values(manifest).some((c) =>
  (c.dynamicImports ?? []).includes(HERO_SCENE),
);
const heroInCriticalClosure =
  base.has(HERO_SCENE) ||
  routes.some((r) => closure(r.key, new Set(base)).has(HERO_SCENE)) ||
  [...base].some((k) => (manifest[k].imports ?? []).includes(HERO_SCENE));
check(
  `3D hero scene (${HERO_SCENE}) is reachable only as a dynamic import${
    heroInManifest ? '' : ' - MISSING from manifest: nothing dynamically imports it yet'
  }`,
  heroInManifest && heroDynamicallyImported && !heroInCriticalClosure ? 1 : 0,
  1,
  { expectExactly: true },
);
if (heroInManifest) {
  const heroKeys = closure(HERO_SCENE);
  for (const k of base) heroKeys.delete(k); // shared code already loaded
  check('3D hero chunk (lazy)', jsBytes(heroKeys), BUDGET.threeD);
}

// Interaction-only chunks: dynamic imports, never in a render-critical closure, each within budget.
for (const key of INTERACTION_CHUNKS) {
  const inManifest = key in manifest;
  const dynamicallyImported = Object.values(manifest).some((c) =>
    (c.dynamicImports ?? []).includes(key),
  );
  const inCriticalClosure =
    base.has(key) ||
    routes.some((r) => closure(r.key, new Set(base)).has(key)) ||
    [...base].some((k) => (manifest[k].imports ?? []).includes(key));
  check(
    `Interaction chunk (${key}) is reachable only as a dynamic import${
      inManifest ? '' : ' - MISSING from manifest'
    }`,
    inManifest && dynamicallyImported && !inCriticalClosure ? 1 : 0,
    1,
    { expectExactly: true },
  );
  if (inManifest) {
    const keys = closure(key);
    for (const k of base) keys.delete(k); // shared code already loaded
    check(`Interaction chunk (${key})`, jsBytes(keys), BUDGET.interactionChunk);
  }
}

const cssFiles = [...new Set(Object.values(manifest).flatMap((c) => c.css ?? []))];
check(
  'CSS (all files)',
  cssFiles.reduce((s, f) => s + gz(f), 0),
  BUDGET.css,
);

const preloads = [...html.matchAll(/<link[^>]+rel="preload"[^>]+as="font"[^>]*>/g)].map(
  (m) => /href="\/?([^"]+)"/.exec(m[0])[1],
);
const preloadBytes = preloads.reduce((s, f) => s + statSync(join(dist, f)).size, 0);
check(`Preloaded fonts (${preloads.length} file(s))`, preloadBytes, BUDGET.preloadedFonts.bytes);
check('Preloaded font count', preloads.length, BUDGET.preloadedFonts.count);
const fontDir = join(dist, 'fonts');
const fontBytes = readdirSync(fontDir)
  .filter((f) => f.endsWith('.woff2'))
  .reduce((s, f) => s + statSync(join(fontDir, f)).size, 0);
check('All font files', fontBytes, BUDGET.allFonts);

let failed = 0;
for (const r of rows) {
  if (!r.ok) failed += 1;
  const status = r.ok ? 'PASS' : 'FAIL';
  if (r.expectExactly) {
    process.stdout.write(`${status}  ${r.name}\n`);
    continue;
  }
  const unit = r.name === 'Preloaded font count' ? String : fmt;
  process.stdout.write(
    `${status}  ${r.name.padEnd(76)} ${unit(r.actual).padStart(9)}  (limit ${unit(r.limit)})\n`,
  );
}
process.stdout.write(failed ? `\n${failed} budget(s) exceeded.\n` : '\nAll bundle budgets met.\n');
process.exit(failed ? 1 : 0);
