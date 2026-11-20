# Phase 2A · M0 baseline (frontend)

Status: **Baseline captured 2026-11-20.** No application code, configuration or dependency was changed
in M0. Phase 2A is the frontend transformation track; it does not authorise the AI-agent / LangGraph
phase.

All measurements were taken locally (macOS, Apple Silicon) against **production builds** served with
`vite preview`, with the real API, PostgreSQL, Redis and audio service running and the development
database containing 8 synthetic recordings.

## 1. Screenshots

`screenshots/` holds 34 full-page captures of the current UI (before redesign):

- Viewports: `desktop` (1440 × 900) and `mobile` (Pixel 7 emulation, 2× scale).
- Themes: `light` and `dark` (OS colour-scheme emulation; no stored theme preference).
- Screens: `dashboard`, `recordings`, `upload`, `upload-ready` (synthetic file selected and consent
  ticked, **not submitted**), `recording-detail`, `not-found`, and on mobile `nav-open`.
- `recordings-empty-simulated` and `recordings-error-simulated` show the empty and error states. Their
  API responses were **simulated inside the browser by request interception** for the screenshot only;
  no application data or code was changed.

File names follow `<viewport>-<theme>-<screen>.png`. Animations were disabled and reduced motion was
emulated for stable captures.

Observed baseline issues worth carrying into the redesign (visual review, not test failures):

- Dashboard statistic values render at roughly body size although the component intends a large
  numeral (`text-3xl`); to investigate in M2.
- Neutral grey surfaces and borders throughout; only the primary colour carries hue.
- Mobile upload: the "Upload complete" toast overlaps the Timeline card (seen in the E2E screenshots).

## 2. Accessibility baseline

Tool: `@axe-core/playwright` 4.14.0 (axe-core 4.14.1), rule tags `wcag2a`, `wcag2aa`, `wcag21a`,
`wcag21aa`, `wcag22aa` and `best-practice`. It ran from an isolated scratch install, **not** as a
repository dependency. 34 scans (one per screenshot). Raw results: `axe-results.json`.

| Impact   | Rule                          | WCAG                | Where                                                                                     | Detail                                                                                           |
| -------- | ----------------------------- | ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Serious  | `color-contrast`              | 1.4.3 (AA)          | Light theme only: dashboard, recordings, recording detail, error state (6 of 34 scans)    | Neutral "Not started" badge `#737373` on `#f5f5f5` = **4.34:1**; error description `#ea1a23` on white = **4.49:1** (need 4.5:1) |
| Serious  | `scrollable-region-focusable` | 2.1.1, 2.1.3 (A)    | Mobile recording detail (light and dark)                                                  | The horizontally scrollable timeline container (`.overflow-x-auto`) cannot be reached by keyboard |
| Moderate | `page-has-heading-one`        | best practice       | Not-found page (all four variants)                                                        | No level-one heading                                                                             |

- 23 of 34 scans have no violations. Dark theme has no contrast violations.
- Needs manual review: `aria-hidden-focus` (incomplete) on the open mobile navigation sheet (light and
  dark). Automated checks cannot decide it; verify with keyboard and a screen reader in M8.
- Automated checks cover only part of WCAG. Keyboard-only and screen-reader walkthroughs remain part
  of each milestone's acceptance.

## 3. Bundle investigation

The current main chunk (`index-*.js`) is **544 KB raw / 165.9 KB gzip**; the shared `states-*.js`
chunk is **161.9 KB / 52.4 KB gzip**.

### Root cause: React development build in the production bundle

The production bundle contains `react-dom-client.development.js`, `react.development.js` and
`react-jsx-dev-runtime.development.js`. React's development build is selected when
`process.env.NODE_ENV` is not `production` at build time.

The repository-root `.env` sets `NODE_ENV=development` (copied from `.env.example`, required by the API
and orchestrator), and `apps/web/vite.config.ts` reads environment files from the repository root
(`envDir: repoRoot`). Rebuilding with `NODE_ENV=production` set in the shell (which takes precedence
over `.env`) produced React's production build and these results:

| Chunk                | Current (gzip) | With `NODE_ENV=production` (gzip) | Change   |
| -------------------- | -------------- | --------------------------------- | -------- |
| `index` (entry)      | 165.9 KB       | 107.5 KB                          | −35%     |
| `states` (shared)    | 52.4 KB        | 45.7 KB                           | −13%     |
| `upload` route       | 6.3 KB         | 5.8 KB                            | −8%      |
| CSS                  | 10.7 KB        | 10.7 KB                           | 0        |

This is a pre-existing Phase 1 build defect; it does not affect functionality or tests, only bundle
size and runtime cost. Fixing it is a configuration change and needs approval (recommendation R1).

### Contributors after the fix (approximate per-module gzip)

| Chunk                         | Contributor                                                                                   | Share |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ----- |
| Entry (`index`, ~104 KB gzip) | React + ReactDOM (production)                                                                 | ~55%  |
|                               | Radix UI and its positioning / scroll-lock dependencies (Sheet, Dropdown, Tooltip, Toast used by the shell) | ~37%  |
|                               | Application code                                                                              | ~4%   |
|                               | lucide-react icons                                                                            | ~2%   |
| Shared (`states`, ~44 KB gzip) | zod (runtime validation of API responses against `@vip/contracts`)                           | ~52%  |
|                               | `cn` (shadcn's compiled clsx + tailwind-merge replacement) and class-variance-authority       | ~20%  |
|                               | Application code, icons, contracts                                                            | ~25%  |

Per-module figures are the sum of individually gzipped modules, so they slightly overstate the real
chunk size. zod and Radix are legitimate (contract validation and accessible primitives); they are
noted, not recommended for removal.

## 4. Performance baseline

Raw results: `perf-results.json`. Cold loads in a fresh browser context, desktop 1440 × 900, median of
three runs, no network throttling (local), with and without 4× CPU slowdown.

| Build                      | CPU | FCP        | LCP        | CLS   | Total blocking time | JS decoded |
| -------------------------- | --- | ---------- | ---------- | ----- | ------------------- | ---------- |
| Current                    | 1×  | 96–108 ms  | 408–444 ms | 0.000 | 0 ms                | ~707 KB    |
| Current                    | 4×  | 288–308 ms | 552–628 ms | 0.000 | 108–121 ms          | ~707 KB    |
| `NODE_ENV=production`      | 1×  | 80–84 ms   | 372–404 ms | 0.000 | 0 ms                | ~483 KB    |
| `NODE_ENV=production`      | 4×  | 196–204 ms | 476–516 ms | 0.000 | 25–27 ms            | ~483 KB    |

Ranges cover the dashboard, recordings, upload and recording-detail pages. LCP waits for the API
response that fills the page. Local numbers are optimistic in absolute terms; the relative difference
and the byte sizes are the reliable signal.

## 5. Budgets

Measured on the production build (`pnpm build`), gzip sizes, enforced by
`pnpm --filter @vip/web check:bundle` (`apps/web/scripts/check-bundle.mjs`). JavaScript budgets apply to
the heaviest page route.

**Amended 2026-11-20 (M1 review, user decision).** The original single budget, "initial JS on any route
(entry + shared chunks) ≤ 170 KB", did not separate code needed for the first render from code loaded
after it. It is replaced by three strict JavaScript budgets:

- **Render-critical JS** (≤ 175 KB): the entry chunk, the chunks it statically imports, and the route
  chunk with its static imports. This is everything needed to render the first screen.
- **Deferred Motion JS** (≤ 20 KB): Motion's animation features (`src/lib/motion-features.ts`), fetched
  asynchronously after first render (ADR-0026). Not needed for the first render; until it arrives,
  elements render in their final state without animation.
- **Combined route JS** (≤ 205 KB): render-critical plus deferred for the same route, so the total
  download is also capped.

The check also fails if the Motion features stop being a separately loaded deferred chunk.

| Budget                                                         | Limit                              | Today (with R1)  |
| -------------------------------------------------------------- | ---------------------------------- | ---------------- |
| Render-critical JS (entry + shared + route)                    | ≤ 175 KB gzip                      | ~159 KB          |
| Deferred Motion JS (after first render)                        | ≤ 20 KB gzip                       | 0 (no Motion yet) |
| Combined route JS (render-critical + deferred)                 | ≤ 205 KB gzip                      | ~159 KB          |
| Any route chunk                                                | ≤ 30 KB gzip                       | ≤ 5.8 KB         |
| CSS                                                            | ≤ 20 KB gzip                       | 10.7 KB          |
| Fonts preloaded on first paint                                 | ≤ 2 files, ≤ 80 KB total (WOFF2)   | 0 (system fonts) |
| All font files                                                 | ≤ 200 KB, loaded on demand         | 0                |
| 3D chunk (D2)                                                  | ≤ 250 KB gzip; **0 bytes** on mobile, reduced motion, no WebGL and first paint | n/a |
| LCP, local production preview, 4× CPU                          | ≤ 1.5 s                            | ~0.5 s           |
| CLS                                                            | ≤ 0.05                             | 0                |
| Total blocking time, 4× CPU                                    | ≤ 100 ms                           | ~26 ms (current build: ~115 ms) |
| axe: serious or critical violations                            | 0 in every scan                    | 2 rules          |

Amended 2026-11-20 (user decision at the end of M6): combined 190 → 205 KB and route chunk 25 → 30 KB. Because render-critical (≤ 175 KB) and deferred Motion (≤ 20 KB) are unchanged, combined cannot exceed 195 KB while they pass, so render-critical is now the binding limit. Details: `docs/design/phase2a-m6/README.md` §5.

"Today (with R1)" is the M0 measurement; the M1 results are in `docs/design/phase2a-m1/README.md` §3 and the M2 results (including the measured 3D chunk) in `docs/design/phase2a-m2/README.md` §3.
The M0 estimate of about 17 KB for Motion was low: Motion 14 measured about 15 KB render-critical plus
18 KB deferred, which led to the amendment above. The pre-R1 build already exceeded the blocking-time
budget at 4× CPU; R1 brings it within budget.

## 6. Recommended changes (for approval)

| #   | Change                                                                                                                                                                                               | Milestone | Type                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------- |
| R1  | Make the web production build independent of the root `.env` `NODE_ENV` (for example set `NODE_ENV=production` for `vite build` in `apps/web`), and note it in `SETUP.md`. Verify with the bundle check above. | M1 (first) | Build configuration     |
| R2  | Raise light-theme contrast for neutral badges and destructive text to ≥ 4.5:1 (part of the M1 token retune).                                                                                       | M1        | Tokens                  |
| R3  | Not-found page gets a level-one heading.                                                                                                                                                             | M1        | Markup                  |
| R4  | Make the scrollable timeline container keyboard-focusable with an accessible name.                                                                                                                  | M5        | Markup                  |
| R5  | Add `@axe-core/playwright` as a `apps/web` dev dependency (D8) and an axe check to the E2E suite with the "0 serious/critical" budget. Compatible with Playwright 1.65.1 (peer `playwright-core >= 1.0.0`); licence MPL-2.0; no bundle impact (about 3.4 MB on disk). | M1        | Dev dependency + tests  |
| R6  | Adopt Playwright `toHaveScreenshot` visual-regression checks (built in, no dependency) using these screens; baselines updated only with approval.                                                   | M1        | Tests                   |
| R7  | Add a bundle-budget check (script comparing build output against §5) once CI exists (OD-17); until then run it per milestone.                                                                     | M1        | Tooling                 |
| R8  | Manually verify `aria-hidden-focus` on the open mobile navigation sheet.                                                                                                                            | M8        | Manual check            |

Decisions D1, D2, D4 and D8 (approved by the user for Phase 2A) resolve OD-33, OD-34, OD-38 and the
axe dev dependency; they are to be recorded as ADRs through the project's ADR process before any of
those dependencies is added.
