# Phase 2A · M7: reports workspace

Acceptance: **Accepted.** Phase 2A was formally accepted on 2026-11-21 after consolidated validation (`../phase2a-validation/README.md` §7). The status line below is kept as written at the time.

Status: **Implemented 2026-11-21, awaiting the user's review.** Frontend only. No backend, contract or dependency
changes. Uncommitted. M8 is not authorised.

User decisions (2026-11-21): honest-state only (no synthetic reports, QA statuses or evidence); shared-shell Option A only;
executive summary deferred until the A6 report structure is designed; a `/reports` index with a sidebar entry and the
reader at `/recordings/:id/report`; `check-bundle.mjs` classifies interaction-only chunks separately; fix the mobile
navigation focus bug.

## 1. What changed

- **Shared shell (Option A).** The mobile navigation sheet (Radix Dialog) and the theme menu (Radix DropdownMenu) load on
  first intent (pointer enter or down, focus, activation). Their trigger buttons render eagerly with the same markup.
  An activation before the chunk arrives is kept; a failed load leaves the button working and retries on the next
  intent. Files: `components/shell/*`, `app-shell.tsx`, `theme-toggle.tsx`.
- **Bundle checker.** `scripts/check-bundle.mjs` now checks deferred Motion (≤ 20 KB) against the Motion closure only. It
  lists interaction-only chunks individually (≤ 30 KB each), requires them to be dynamic imports outside every
  render-critical closure, excludes them from combined, and fails on any unclassified deferred chunk. Budget text: M0
  README §5 (amendment 2026-11-21).
- **Mobile navigation focus fix.** Opening the sheet focuses the current page's link (the old selector list always matched
  "Overview" first).
- **`/reports` index** (sidebar entry after Recordings). One row per loaded recording from `GET /recordings`: filename,
  upload time, run status, report availability and its reason, and "Open report". Search by filename and sort (newest,
  oldest, name) apply to the loaded recordings, with a visible scope line ("Showing X of Y loaded recordings"). A
  neutral status notice says no reports exist because A6 and A7 are not connected. A native `<select>` is used for sort
  to keep Radix out of the route.
- **`/recordings/:id/report` reader.** Breadcrumb, "Not generated" badge and reason. Report details with real values
  (recording, upload time, run status) and "Not available yet" for report version, language, source transcript version,
  QA review and generation time. A provenance legend (recorded, external, inferred; provenance tokens, icon plus text).
  Empty slots for report sections, references and evidence, and two separate cards for audio limitations and
  transcription uncertainty (FR-9.3). An export panel with no controls.
- **Recording detail.** A "Report" card under Processing status, linking to the reader.

## 2. Honesty rules applied

`reportAvailability()` (`components/reports/model.ts`) always returns "Not generated", whatever the run status, because
no report API exists. The reason comes from the real `latestRun`: no run, `created` (pipeline not connected), or any
other status (report service not available yet). The UI shows no report status values, versions, languages, sections,
QA results, evidence or export actions, and no executive summary.

## 3. Verification (production build via `vite preview`, live API, 17 real recordings, all runs `created`)

| Check | Result |
| --- | --- |
| Lint, typecheck, unit tests | Pass (100 tests) |
| `check:bundle` | All budgets met |
| axe, overflow and console errors: 3 pages × 5 widths (1440, 1280, 820, 412, 360) × 2 themes, reduced motion | axe 0 violations in all 30 scans; no console errors; overflow only on recording detail at 412 and 360 (pre-existing, §5) |
| Interaction chunks | Not fetched on load on any route; fetched on first focus or hover |
| Theme menu | Enter, ArrowDown and click open on first use; focus moves into the menu and returns on Escape; outside click; Light/Dark/System work; no trigger layout shift |
| Mobile sheet (360, 390, 412) | Opens on first use; focus trap; scroll lock; Escape returns focus; links navigate and close; slow (1.5 s) and failed chunk loads handled |
| Sheet focus | Current page's link on `/`, `/recordings`, `/pipeline`, `/recordings/new`, a recording, a report; first link on not-found |
| Reports index | Search narrows; no-match state with Clear; sort by name; keyboard Enter on "Open report" opens the reader |
| Reader | One h1, h2 per card; no enum, OD or language values; no export buttons; Reports nav active; unknown id shows "Recording not found" |

A change request from verification was applied: the provenance legend overflowed the narrow side column at desktop
widths and is now a vertical stack at every breakpoint.

## 4. Bundle budgets (KB gzip; limits: render-critical 175, combined 205, route 30, Motion 20, interaction 30 each)

| Route | Render-critical before → after | Combined after | Own chunk |
| --- | --- | --- | --- |
| recordings | 169.6 → 171.0 | 189.3 | 3.5 |
| dashboard | 171.4 → 161.3 | 179.6 | 6.2 |
| pipeline | 171.6 → 161.3 | 179.6 | 7.3 |
| upload | 171.2 → 161.0 | 179.3 | 6.6 |
| recording-detail | 170.1 → 160.5 | 178.8 | 4.7 |
| reports (new) | 159.4 | 177.7 | 2.7 |
| report (new) | 158.9 | 177.2 | 3.1 |
| not-found | 163.7 → 153.4 | 171.7 | 0.4 |

Option A saved 10.6 KB of render-critical JS on every route except recordings (planning estimate about 15 KB). The
recordings toolbar imports the dropdown statically, so that code moved from the entry into its route: recordings is now
the heaviest route (171.0, 4.0 KB headroom). Interaction chunks: theme menu 11.8, mobile sheet 7.6. Motion 18.3. CSS 14.2.

## 5. Findings recorded for the consolidated Phase 2A review (not fixed in M7)

1. With focus on a link inside the mobile sheet, the first Escape closes a tooltip and only the second closes the sheet
   (same before M7).
2. axe reports `aria-hidden-focus` (serious), `page-has-heading-one` and `region` while the Radix theme menu is open (same
   before M7; earlier scans ran with menus closed).
3. Recording detail overflows horizontally on mobile (47 px at 412, 99 px at 360) when the filename is long and unbroken:
   the `h1` and breadcrumb do not wrap. Same before M7 (M5 screen).
4. Recordings is the heaviest route because its toolbar uses the Radix dropdown; lazy-loading it would return about 10 KB.
5. `pnpm format:check` fails only on the external, untracked `.agents/`, `.codex/` and `AGENTS.md`; all M7 files pass.

## 6. Screenshots (`screenshots/`)

`{desktop-1440,mobile-412}-{light,dark}`, `tablet-820-light` and `mobile-360-dark` for `reports`, `report` and
`recording-detail` (18 files; full page except recording detail).

**Provenance note (2026-11-21).** The original M7 `report` and `recording-detail` captures (12 files) were overwritten by
mistake during M8 verification, so the files under those plain names are M8-time captures that already show the M8
evidence links; the originals cannot be recovered. During Phase 2A consolidated validation the same 12 views were
recaptured as `*-refreshed-2026-11-21.png` (current code, including M8 links, 19 recordings). They are refreshed captures,
not the originals. The six `reports` images are the original M7 captures.
