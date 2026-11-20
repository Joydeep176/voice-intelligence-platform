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
  // Deferred = Motion's animation features, fetched asynchronously after first render.
  deferredMotionJs: 20 * KB,
  combinedJs: 205 * KB, // render-critical + deferred for the same route
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

// Page routes are the lazily loaded src/pages/* chunks. Any other chunk the entry imports
// dynamically is deferred: it is fetched after first render and is not needed to render it.
const MOTION_FEATURES = 'src/lib/motion-features.ts';
const dynamic = manifest[entryKey].dynamicImports ?? [];
const deferred = dynamic.filter((k) => !k.startsWith('src/pages/'));
const deferredKeys = new Set();
for (const k of deferred) closure(k, deferredKeys);
for (const k of base) deferredKeys.delete(k); // already counted as render-critical

check(
  `Motion features load asynchronously (${MOTION_FEATURES} is a deferred chunk)`,
  deferred.includes(MOTION_FEATURES) && !base.has(MOTION_FEATURES) ? 1 : 0,
  1,
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
  `Deferred JS after first render: Motion features (${deferred.join(', ') || 'none'})`,
  jsBytes(deferredKeys),
  BUDGET.deferredMotionJs,
);
check(
  `Combined route JS: render-critical + deferred (${heaviestCombined.key})`,
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
