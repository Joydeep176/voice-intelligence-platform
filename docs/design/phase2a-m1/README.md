# Phase 2A · M1: design system and application shell

Acceptance: **Accepted.** Phase 2A was formally accepted on 2026-11-21 after consolidated validation (`../phase2a-validation/README.md` §7). The status line below is kept as written at the time.

Status: **Implemented 2026-11-20; budgets amended after review; awaiting final review.** Scope: tokens, fonts, Motion, the application shell
and shared components. Page layouts (M2 dashboard, M3 library, M4 upload) are intentionally unchanged.

## 1. What changed

- **Design tokens** (`apps/web/src/index.css`): navy-tinted foundations (light: cool off-white; dark:
  deep navy-charcoal), indigo primary, brand accents (indigo, violet, blue, restrained cyan) and a brand
  gradient for chrome only (ADR-0030), layered elevation shadows, motion durations and easing. shadcn
  variable names are unchanged. Semantic families (provenance, audio diagnostics, transcription
  uncertainty, speakers) are kept separate; light-theme values retuned for contrast.
- **Automated token contrast test** (`src/styles/tokens.test.ts`): 26 text-on-surface pairs per theme,
  including text at 90% opacity and on 10% tints, must meet 4.5:1.
- **Fonts** (ADR-0028): official, unmodified IBM Plex WOFF2 files in `apps/web/public/fonts` (provenance
  and hashes in its README): Plex Sans variable (Latin-1, preloaded), Plex Mono Regular (Latin-1) and
  Plex Sans Devanagari Regular (Devanagari code points only). Files are not subset because the OFL
  reserves the "Plex" name for unmodified fonts.
- **Motion** (ADR-0026): `motion@14.10.1`; `LazyMotion` (`strict`, features loaded asynchronously in
  their own chunk), `MotionConfig reducedMotion="user"`, and one short page transition. With reduced
  motion the page only fades. The transition applies its hidden starting state only after the
  feature bundle has loaded, so content never waits for deferred code: with the bundle delayed by 3 s
  or blocked, pages render fully visible (verified; an earlier M1 build kept the page at opacity 0
  until the bundle arrived).
- **Application shell**: brand mark, sidebar with a "Workspace" section, gradient active marker,
  collapsible icon rail (remembered per browser), live system status from `/health`, translucent sticky
  header with workspace context and theme menu, matching mobile sheet that focuses the current page.
- **Shared components**: card elevation, primary button glow, page-header type scale, empty-state
  surface; `EmptyState` can render a level-one heading.
- **Accessibility fixes from M0**: light contrast (R2), not-found `h1` (R3), focusable timeline scroll
  region (R4, brought forward because the new axe gate would otherwise fail).
- **Tests and budgets**: `e2e/accessibility.spec.ts` (axe, ADR-0029) and
  `pnpm --filter @vip/web check:bundle` (`scripts/check-bundle.mjs`, Vite manifest enabled).

## 2. Results

| Check | Result |
| --- | --- |
| Unit tests | 68 passed (16 existing + 52 token contrast) |
| E2E | 27 passed, 3 skipped by design (5 workflow tests + 22 axe tests) |
| axe (E2E gate) | 0 serious/critical violations; desktop and mobile, light and dark, every screen and the mobile sheet |
| axe (34-scan capture, `axe-results.json`) | 0 violations of any impact (M0: 2 serious rules, 1 moderate) |
| Lint, typecheck, format, build | Passed |
| Behaviour checks (scratch Playwright) | 14/14: Plex fonts in use (English, Hindi, Hinglish, bold Hindi, Mono); Devanagari not clipped; Devanagari file not loaded on English pages; page transition moves normally and only fades with reduced motion; skip link first; desktop nav, rail collapse and persistence; mobile sheet |
| Performance (`perf-results.json`, local, 4× CPU) | CLS 0; total blocking time 34–46 ms (R1: 25–27; M0: 108–121) |

## 3. Bundle budgets

Enforced by `pnpm --filter @vip/web check:bundle`; gzip; JavaScript budgets apply to the heaviest page
route. After the M1 review the single initial-JS budget was replaced by three strict JavaScript budgets
(definitions and rationale: `docs/design/phase2a-m0-baseline/README.md` §5):

- **Render-critical JS**: needed for the first render (entry, its static imports, the route chunk).
- **Deferred Motion JS**: Motion's animation features, fetched after first render and not needed to
  render or show content.
- **Combined route JS**: both together, capping the total download.

| Budget | Before M1 (R1) | M1 | Limit |
| --- | --- | --- | --- |
| Render-critical JS (`src/pages/upload.tsx`) | ~159 KB | **170.1 KB** | 175 KB |
| Deferred Motion JS (`src/lib/motion-features.ts`) | 0 | **18.3 KB** | 20 KB |
| Combined route JS (`src/pages/upload.tsx`) | ~159 KB | **188.4 KB** | 190 KB |
| Motion features load as a separate deferred chunk | n/a | yes | required |
| Route chunks | ≤ 5.8 KB | ≤ 5.7 KB | 25 KB each |
| CSS | 10.7 KB | 11.6 KB | 20 KB |
| Preloaded fonts | 0 | 1 file, 67.4 KB | 2 files, 80 KB |
| All font files | 0 | 186.0 KB | 200 KB |

All budgets pass. Headroom is small (render-critical 4.9 KB, deferred 1.7 KB, combined 1.6 KB), so new
code in later milestones should prefer route chunks. Motion 14 adds about 15 KB to the render-critical
entry chunk (`LazyMotion`, `MotionConfig`, `m`) and 18 KB of deferred features; the M0 estimate of
about 17 KB in total was low.

## 4. Screenshots

`screenshots/` mirrors the M0 set (`docs/design/phase2a-m0-baseline/screenshots/`, the "before"):
same 34 names, plus `desktop-dark-rail-collapsed.png` and `font-sample-desktop-light.png` (the font
sample is injected into the page by the verification script only). The development database now holds
more synthetic recordings than at M0, so lists are longer.

## 5. Outstanding

- Bundle headroom is small (see §3).
- Devanagari SemiBold not shipped (font budget); bold Devanagari is browser-synthesised until the
  transcript and report screens.
- `aria-hidden-focus` on the open mobile sheet remains "needs review" (M0 R8, manual check in M8).
- Visual-regression snapshots (M0 R6) not added; screenshots are captured for human review.
- Dashboard statistic size and the mobile toast overlap remain for M2/M4.
