# Phase 2A · M2: dashboard

Acceptance: **Accepted.** Phase 2A was formally accepted on 2026-11-21 after consolidated validation (`../phase2a-validation/README.md` §7). The status line below is kept as written at the time.

Status: **Implemented 2026-11-20; awaiting review.** Scope: the Overview page only. M3 (library), M4 (upload) and the
recording-detail workspace are unchanged. Decisions: ADR-0031 (hero 3D in M2) and ADR-0032 (hero uses three.js without
React Three Fiber).

## 1. What changed

- **Hero** (`components/dashboard/hero*.tsx`):
  - The purpose statement is "Understand every conversation — across English, हिन्दी and Hinglish."
  - A short honesty line says what exists today, followed by language chips and Upload / View recordings actions.
  - The surface has one restrained brand gradient (brand accents in chrome or hero only, per ADR-0030).
  - The `<h1>` is still "Overview".
- **3D hero** (`components/hero-3d/hero-scene.ts`, plain three.js, named imports only):
  - A point-cloud "voice signature" sphere, displaced by a static, deterministic wave (not data), framed by three thin rings with a soft core glow. Colours come from the `--brand-*` tokens and update on theme change.
  - Rendering happens only on first frame, resize, theme change and while a pointer-driven tilt (at most 8°) eases to rest. There is no loop, idle animation or auto-rotation, and nothing renders off screen.
  - Setup runs in yielded slices with `compileAsync`, so it doesn't block the main thread.
  - Context loss or an import failure falls back to 2D.
- **When 3D loads** (`use-hero-3d.ts`, `hero-canvas.tsx`):
  - Only after `load` and idle, and only when all of these hold: width ≥ 1024 px with a fine pointer, no reduced-motion preference, no data saver, a visible tab, and WebGL available.
  - Otherwise the 2D SVG (waveform → Audio → Context → Evidence) is the complete experience. It is always rendered first and stays underneath the 3D layer.
- **KPI cards** (real data): Recordings, Awaiting analysis (run `created`), Uploads in progress (`uploading`), Rejected uploads (`invalid`).
  - There is no "processed" card: no code path produces a completed run yet.
  - Counts cover up to 500 recordings (5 pages); beyond that they show "N+" with the scope stated.
  - The M0 note about statistic size is fixed: values now render at `text-4xl`.
- **Recent recordings**:
  - The six most recent, each a link to its detail page.
  - Each row shows date and time, format, size, upload status and processing status ("No run" when absent).
  - Loading, empty and error states.
- **System health**: API, Database, Job queue and Audio service, polled every 30 s, with the latest result always winning.
  - "Checking…" before the first result.
  - An HTTP 503 report is shown as **Outage**, naming the failed dependency (API §8).
  - A failure to reach the API shows API "Unavailable" and the other services "Not checked — API unreachable", never green.
  - Reason codes are mapped to fixed copy. Null latency is never shown as "0 ms".
- **Capabilities panel**: what works today versus what arrives in later phases, labelled "Not available yet".
- **Bundle check**: two new checks. The 3D chunk must be reachable only through a dynamic import, and it must stay at or under 250 KB gzip. No existing check was changed.

## 2. Data sources (existing API only; no backend change)

| UI | Endpoint |
| --- | --- |
| KPIs, recent recordings | `GET /api/v1/workspaces/{id}/recordings?limit=100&cursor=…` (≤ 5 pages) |
| System health | `GET /api/v1/health` (200 or 503 with a contract-valid body) |

## 3. Bundle budgets (`pnpm --filter @vip/web check:bundle`, gzip)

| Budget | M1 | M2 | Limit |
| --- | --- | --- | --- |
| Render-critical JS (heaviest route) | 170.1 KB (upload) | **171.3 KB (dashboard)** | 175 KB |
| Deferred Motion JS | 18.3 KB | 18.3 KB | 20 KB |
| Combined route JS (heaviest route) | 188.4 KB (upload) | **189.6 KB (dashboard)** | 190 KB |
| Dashboard route chunk | 1.5 KB | 6.1 KB | 25 KB |
| 3D hero chunk (lazy; 0 bytes on fallback paths) | n/a | **130.0 KB** | 250 KB |
| CSS | 11.6 KB | 12.3 KB | 20 KB |
| Preloaded fonts | 1 file, 67.4 KB | unchanged | 2 files, 80 KB |

The R3F option was measured before any UI was built: 256.6 KB, over budget. That measurement led to ADR-0032.

**Headroom is now 0.4 KB on the combined budget.** Later milestones must move code out of shared chunks before adding to them.

## 4. 3D loading behaviour (production build, `verify-results.json`)

| Configuration | 3D chunk fetched | Result |
| --- | --- | --- |
| Desktop, dark / light | yes, at about 120–220 ms (after FCP at about 72–132 ms) | Canvas fades in, `aria-hidden` |
| Mobile (Pixel 7), dark / light | **no (0 bytes)** | 2D |
| Desktop, reduced motion | **no (0 bytes)** | 2D |
| Desktop, WebGL disabled | **no (0 bytes)** | 2D |

## 5. Performance (local production preview, headless Chromium)

| Metric | M1 | M2 | Budget |
| --- | --- | --- | --- |
| FCP / LCP, 4× CPU | 212 / 308 ms | 220 / 388 ms | LCP ≤ 1.5 s |
| CLS | 0 | 0 (4×); 0.018 (1×) | ≤ 0.05 |
| TBT, 4× CPU | 34–46 ms | median 35 ms (software GL), median 38 ms (Metal GPU) | ≤ 100 ms |

TBT is the most variable of these measurements, so 8 runs per configuration were taken:

- **Software GL:** all 8 runs were 31–41 ms.
- **Hardware GPU (Metal):** 6 of 8 runs were 32–41 ms; 2 were 165 and 215 ms.
- **Metal without 3D (reduced motion):** 1 of 8 runs was also 136 ms.

So the outliers occur with and without the 3D hero, which points to the environment more than the hero. Eight runs cannot rule out a small added cost from 3D.

Before the yielded setup, the 3D upgrade added one long task of about 290 ms on every run. It was found and removed during M2.

Measured on the development machine; its WebGL renderer reports an Apple M1.

## 6. Accessibility

- **axe** (`verify-results.json`; desktop and mobile, light and dark): **0 violations of any impact.**
  - `color-contrast` is flagged as "needs review". axe cannot compute contrast for text over the hero gradient.
  - The hero text uses the foreground tokens covered by `tokens.test.ts`. Visually it reads clearly in both themes.
- **Semantic outline**: one `h1` ("Overview"), then `h2` section titles, then `h3` sub-lists. During M2, card titles were found to be `div`s and were made real headings.
- **E2E**:
  - The dashboard spec checks that keyboard Tab reaches "Upload recording" with a visible focus ring, and that no 3D request or canvas appears on mobile or with reduced motion.
  - The axe gate covers every screen in both themes and on both viewports.
- **Health statuses**: always an icon plus text. `role="status"` is on the summary only.
- **Hero visuals**: the 2D and 3D visuals are decorative and `aria-hidden`; the information is in the text.
- **Without WebGL or animation**: the page is fully usable.

## 7. Tests

| Check | Result |
| --- | --- |
| Unit (Vitest) | 100 passed. That is 68 existing, plus 21 dashboard tests (`pages/dashboard.test.tsx`) and 11 eligibility tests (`use-hero-3d.test.ts`) |
| E2E (`dashboard.spec.ts` + `accessibility.spec.ts`, run once, read-only) | 28 passed, 8 skipped (project-gated) |
| Typecheck, lint, format, build, bundle check | Passed |

`upload-workflow.spec.ts` was not re-run, to avoid adding synthetic recordings. Its dashboard assertion (the "Overview" `h1`) is kept and covered by the unit tests.

## 8. Screenshots (`screenshots/`)

| File | What it shows |
| --- | --- |
| `desktop-dark-dashboard.png` / `desktop-light-dashboard.png` | Full page, 1440 × 900, 3D hero |
| `mobile-dark-dashboard.png` / `mobile-light-dashboard.png` | Pixel 7, 2D hero |
| `desktop-dark-hero-3d.png` / `desktop-light-hero-3d.png` | 3D hero on a supported desktop |
| `desktop-dark-hero-2d-fallback-reduced-motion.png` | 2D fallback, reduced motion |
| `desktop-light-hero-2d-fallback-no-webgl.png` | 2D fallback, WebGL disabled |

The "before" screenshots are in `docs/design/phase2a-m1/screenshots/*-dashboard.png`.

## 9. Limitations and dependencies

- **Counts:** there is no count endpoint, so KPIs cover the 500 most recent recordings (labelled). Exact totals need an API change, which would need approval.
- **Processing data:**
  - "Successfully processed" and any activity feed need the pipeline, which is a later phase.
  - Only the `created` run state occurs today.
- **App-shell status indicator:** the shared indicator (M1, `components/system-status.tsx`) still treats an HTTP 503 health report as "Status unavailable" rather than "Service outage". The dashboard panel handles 503 correctly; the shell indicator was left unchanged to stay in scope.
- **Console warning:** three.js logs "KHR_parallel_shader_compile not supported" on browsers without that extension. It is harmless.
- **Budget headroom:** the combined budget has 0.4 KB left (see §3).
