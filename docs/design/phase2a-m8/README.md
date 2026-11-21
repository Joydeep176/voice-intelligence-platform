# Phase 2A · M8: evidence exploration

Acceptance: **Accepted.** Phase 2A was formally accepted on 2026-11-21 after consolidated validation (`../phase2a-validation/README.md` §7). The status line below is kept as written at the time.

Status: **Implemented 2026-11-21, awaiting the user's review.** Frontend only. No backend, contract, table or dependency
changes. Uncommitted.

User decisions (2026-11-21): honest-state only (no synthetic evidence, claims, sources, URLs, verdicts, numbers or
relationships); a recording-level page at `/recordings/:id/evidence` with no sidebar entry and Reports kept active; links
from the report page and recording detail; no verdict values from OD-30; no snapshot or research-provider functionality;
record zero additional spending as ADR-0034.

## 1. What changed

- **ADR-0034 (zero additional spending)**, Accepted. New register rows OD-46 (Accepted) and OD-47 (production LLM
  inference, Open). Conflicts flagged, not changed: OD-07 / ADR-0013, OD-05 suggestion, OD-03b "managed", HLD §2 "Primary
  LLM", SRS C-2. The provider-adapter and pipeline-agent skills reference ADR-0034.
- **`/recordings/:id/evidence`** (`pages/evidence.tsx`, `components/evidence/*`): breadcrumb (Reports › file › Evidence),
  "Not available" badge, "View report" link, and a neutral notice with a reason from the real run status
  (`evidenceAvailability()`, always unavailable). Then:
  - "How evidence will work", labelled **Planned**: a six-step ordered list (claim, research question, source, evidence
    passage, validation, report statement) written from SRS FR-6 to FR-9, ADR-0009, ADR-0014 and ADR-0017. Recorded and
    External chips on steps 1 and 6. "Verdict categories are not decided yet."
  - "Recorded, external and inferred": meaning and what each type links to; "An inference is never presented as verified."
  - "Fetched and snippet-only sources": only fetched sources can support or contradict a claim (FR-8.2).
  - Empty Claims, Research queries, Sources, Evidence passages and Validation cards naming the fields they will show.
  - "What is needed": the agents, a research provider, verdict categories, snapshot storage and retention policy.
- **Links:** the report page's "References and evidence" card has "Open evidence workspace"; the recording detail Report
  card has a second link, "Evidence".

## 2. Verification (production build via `vite preview`, live API, 17 real recordings, all runs `created`)

| Check | Result |
| --- | --- |
| Lint, typecheck, unit tests | Pass (100 tests) |
| `check:bundle` | All budgets met |
| axe, overflow, console: evidence, report and recording detail × 5 widths × 2 themes, reduced motion | axe 0 in all 30 scans; no console errors; overflow only on recording detail at 412/360 (pre-existing, §4) |
| Integrity scan of page text | No verdict values, OD/ADR numbers, URLs or example data; "Planned" label present; no buttons in main |
| Structure | One h1, h2 per card; the chain is an ordered list of 6 |
| Navigation | Report → evidence, evidence → report, detail → evidence (mouse and keyboard); unknown id shows "Recording not found"; Reports active; mobile sheet focuses Reports |
| Long unbroken filename at 360 px | No overflow (breadcrumb truncates, full name kept as link text and title) |
| M7 and shell regression suites | Unchanged results |

Change requests applied during verification: removed an unused side column, removed duplicate notice text, merged two
provenance cards into one, put the five empty sections in a two-column grid at lg, and fixed breadcrumb overflow with long
filenames (`grid-cols-[minmax(0,1fr)]` on the page root, `min-w-0` on the nav, `block truncate` plus `title` on the link).

## 3. Bundle budgets (KB gzip; limits 175 / 205 / route 30)

| Route | Render-critical | Combined | Own chunk |
| --- | --- | --- | --- |
| evidence (new) | 160.0 | 178.3 | 3.3 |
| report | 159.7 | 178.0 | 1.3 |
| recording-detail | 160.7 | 179.0 | 4.7 |
| recordings (heaviest) | 171.4 | 189.7 | 3.5 |

The shared base grew 0.2 KB (routes and nav match). No budget changed.

## 4. Findings for the consolidated Phase 2A review (not fixed in M8)

1. The breadcrumb overflow fixed on the evidence page still exists on the report page (M7, 537 px with a 120-character
   filename) and recording detail (M5). Apply the same three classes. Recording detail also overflows today with the real
   `voice_intelligence_upload_test.mp3` because its `h1` does not wrap (M7 README §5 item 3).
2. The five empty-section cards leave Validation alone in the last row at lg; acceptable, noted for polish.
3. Carried over from M7 README §5: the sheet Escape/tooltip order, axe findings while the theme menu is open, and the
   recordings route dropdown (heaviest route).
4. Process note: re-running the M7 verification script during M8 overwrote `docs/design/phase2a-m7/screenshots/`
   (uncommitted, so not recoverable from git). The `report` and `recording-detail` images there now include the M8
   evidence links; the `reports` images are unchanged in content.

## 5. Screenshots (`screenshots/`)

Evidence page: `{desktop-1440,mobile-412}-{light,dark}`, `tablet-820-light`, `mobile-360-dark` (full page). Links:
`desktop-1440-dark-report-links`, `desktop-1440-dark-recording-detail-links`, `mobile-360-light-recording-detail-links`.
