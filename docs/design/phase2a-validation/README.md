# Phase 2A · consolidated validation (M0–M8)

Status: **Passed. Phase 2A formally accepted by the user on 2026-11-21** (§7). §1–§5 record the validation as found and §6 the
remediation; earlier status wording is superseded.

Method: one Sonnet test engineer (tests only), an Opus architecture reviewer and an Opus security reviewer (both read-only),
plus main-session browser, accessibility and performance audits against the production build (`vite preview`) and the live
API with real development data (17 recordings, 19 after the E2E upload tests).

## 1. Test report

### 1.1 Reused evidence (not rerun)

| Milestone | Evidence | Status |
| --- | --- | --- |
| M0 | Baseline axe (34 scans), bundle and performance (`phase2a-m0-baseline/`) | Reused as baseline |
| M1 | 68 unit, E2E 27 passed / 3 skipped, axe gate 0 serious/critical (`phase2a-m1/README.md` §2) | Reused; suites rerun below as regression because M7/M8 changed the shared shell |
| M2 | 100 unit, E2E 28 passed / 8 skipped, axe 0 (`phase2a-m2/README.md` §7) | Reused; suites rerun below |

**Correction to the testing history:** M3's dedicated tests were deferred to this cycle (M5 README §7, M7 handoff), and the
unit count stayed at 100 from M2 to M8. M3 was therefore tested here with M4–M8.

### 1.2 Newly executed

| Suite | Result |
| --- | --- |
| Web unit (Vitest), before new tests | 7 files, 100 passed |
| Web unit, with new tests | 14 files, **170 passed** (+70) |
| API unit (Jest) | 11 suites, 115 passed |
| Orchestrator unit | 3 passed |
| Contracts / DB unit | 17 / 4 passed |
| Integration (`pnpm test:integration`, `_test` database, temp storage) | 12 passed |
| Audio service (Pytest) / audio lint (ruff, format, mypy) | 17 passed / clean |
| `pnpm lint`, `pnpm typecheck` (after new tests) | Clean |
| E2E, desktop + mobile (`pnpm test:e2e`) | 53 passed, **4 failed**, 11 skipped (project-gated by design) |
| E2E `navigation.spec.ts` (new) | 9 passed, 1 skipped (desktop-only journey) |
| `check:bundle` | All budgets met |
| `pnpm audit` | Production: no known vulnerabilities. Dev-only: 3 moderate (esbuild, glob, minimatch) |

The 4 E2E failures are one defect: the existing axe gate on `/recordings` (light and dark, both projects) fails
`color-contrast` (P2A-01).

New test files (tests only, no implementation change): `lib/router.test.ts` (all routes), `components/recordings/model.test.ts`
(M3), `components/upload/sniff.test.ts` (M4), `components/recording/playback-url.test.ts` (M5),
`components/pipeline/topology.test.ts` (M6), `components/reports/model.test.ts` (M7), `components/evidence/model.test.ts`
(M8), `e2e/navigation.spec.ts` (cross-module journey, Reports nav state, unknown ids, theme persistence), and
`e2e/accessibility.spec.ts` extended to `/pipeline`, `/reports`, a report and an evidence page. Backend playback expiry,
tampered tokens, range and other-workspace 404 were already covered by existing API tests.

E2E side effect: 2 synthetic recordings added (`e2e-synthetic-{desktop,mobile}-<ts>.wav`). No data was deleted.

Not run: component tests for the audio-player expiry/refresh logic, upload resume-confirmation states and mobile sheet focus
(not present; the behaviour was checked in the browser during M4–M8). Python dependency advisory scan (no free tool is
installed; adding one needs approval).

### 1.3 Cross-module browser checks (main session)

110 scans: 11 views (dashboard, recordings, upload, recording detail, pipeline, pipeline with a recording, reports, report,
evidence, not-found, report for an unknown id) × 5 widths (1440, 1280, 820, 412, 360) × 2 themes, reduced motion. Every
page has one `main`, `lang="en"`, a route title, and a skip link as the first Tab stop. Earlier M5–M8 checks (theme menu, mobile
sheet, chunk loading, navigation, integrity scans) were rerun with unchanged results.

## 2. Accessibility and responsive audit

| Result | Detail |
| --- | --- |
| axe | 0 violations on every view except `/recordings` (P2A-01) |
| Overflow | Recording detail at 412/360 with the real filename (P2A-02) |
| Headings | "Recording not found" states have no h1 (P2A-03) |
| Theme menu open | axe `aria-hidden-focus` plus two moderate rules, from Radix's modal menu (P2A-04) |
| Sheet Escape / tooltip | **Not a defect.** Escape closes the sheet first time; only with focus on the status control is a tooltip open, and Escape dismisses it first as WCAG 1.4.13 requires |
| Keyboard, focus, reduced motion | Pass (skip link, sheet trap and return, menu, current-page focus, no motion with reduced motion) |

## 3. Performance and bundle report (4× CPU, local preview)

All budgets pass. Heaviest route: recordings, 171.4 / 175 KB render-critical, 189.7 / 205 combined (its toolbar loads the
Radix dropdown). Route chunks 0.4–7.3 KB; Motion 18.3 / 20; interaction chunks 11.8 and 7.6 / 30 each, fetched only on first
interaction; CSS 14.2 / 20; 3D 130 / 250, loaded only on desktop dashboard (not on mobile or reduced motion).
Web vitals: LCP 252–932 ms (budget 1.5 s; highest is the desktop dashboard with 3D), CLS ≤ 0.026 (budget 0.05), TBT ≤ 66 ms
(budget 100). Largest render-critical contributors: React DOM ≈ 57 KB, zod ≈ 22 KB, `cn` ≈ 10 KB.

## 4. Findings register

Severity: C/H/M/L/I. "Blocks" = blocks Phase 2A acceptance (recommendation).

| ID | Sev | Type | Location | Finding | ADR | Blocks |
| --- | --- | --- | --- | --- | --- | --- |
| P2A-01 | M | Accessibility defect | `apps/web/src/components/recordings/toolbar.tsx:92` | Filter-chip count uses `opacity-70`: contrast 3.37 (light), 4.31 (dark). Axe gate red on `/recordings` | ADR-0029 gate | **Yes** |
| P2A-02 | M | Responsive defect / debt | `pages/recording-detail.tsx` (h1, breadcrumb), `pages/report.tsx` (breadcrumb) | Long unbroken filenames overflow on mobile (47/99 px today on detail; 537 px on report with a long name). Breadcrumb and page frame copied in three pages (ARCH-02) | — | **Recommend** |
| P2A-03 | L | Accessibility | 404 `EmptyState` in report, evidence, recording detail | No h1 on "Recording not found" (`headingLevel={1}` exists) | — | Recommend |
| P2A-04 | L | Accessibility (tool finding) | `components/shell/theme-menu.tsx` | Axe flags hidden focusable skip link while the modal menu is open; focus is trapped, so no practical impact | — | No |
| ARCH-01 | H | Doc conflict | HLD §2, SRS C-5, DEPLOYMENT_ARCHITECTURE, API §2 | AWS ECS/RDS/S3 production target conflicts with ADR-0034 "no cloud expenditure"; not flagged | ADR-0034 (docs) | No (needs a user decision) |
| SEC-01 | M | Vulnerability (local) | `apps/api/src/bootstrap.ts` | No Host check while auth is off: DNS rebinding could read recordings from the developer's machine | ADR-0004 in practice | No, fix before real consented audio |
| SEC-02 | M | Deferred production | `recordings.service.ts` | Expired upload parts never deleted; no quotas or rate limits | OD-09b, OD-10 open | No |
| SEC-04 / ARCH-07 | L | Data-integrity defect | `recordings.service.ts:211–267` | `complete()` composes the original before taking the row lock; concurrent completes can drift from the stored hash | ADR-0007 spirit | No |
| SEC-05 | L | Hardening | `app-config.ts:21` | Non-loopback bind allowed while `AUTH_MODE=dev` | — | No |
| SEC-03 | L | Defect | `contracts/recordings.ts:44` | Consent `statementVersion` not checked against a known statement | OD-09b open | No |
| SEC-06 | L | Hardening | `bootstrap.ts` | No baseline security headers on JSON/SPA responses | — | No |
| SEC-07 | L | Hardening | `contracts/recordings.ts:49–55` | Filenames allow bidi/C1 control characters (display spoofing; no XSS) | — | No |
| SEC-08 | L | Hardening (tool config) | `.claude/settings.json` | Deny rules: no `Write`/Bash env-read rules, `.env.*` variants, root-anchored path form to verify | — | No (user decision) |
| ARCH-03 | L | Debt | `reports/report-panels.tsx`, `evidence/evidence-panels.tsx` | Provenance labels, icons and tokens defined twice | ADR-0030 drift risk | No |
| ARCH-04 | L | Debt | `pages/reports.tsx`, `pages/recordings.tsx` | Pagination state and sort helpers duplicated | — | No |
| ARCH-05 | L | Stale docs | API spec line 3, HLD line 4, DATABASE_DESIGN `upload_sessions` | Implemented playback endpoints missing; "No application code exists"; `total_parts` missing | Doc rule | No (cheap) |
| ARCH-06 | L | Doc | API §3 / `contracts/runs.ts` | `GET /runs/{id}` implemented as a subset; not stated | — | No |
| ARCH-09 | L | Defect (foundation) | `queue/foundation-check.producer.ts` | Hard-coded job retention; listener added per call | ADR-0010 spirit | No |
| ARCH-10 | L | Defect | `playback/media.controller.ts:96` | Mid-stream read errors silently discarded | — | No |
| ARCH-13 | I | Dependency risk | `apps/orchestrator/package.json` | `ts-jest ^29` with `jest ^30` (tests pass) | — | No |
| DEP-01 | L | Dev dependency | lockfile | 3 moderate advisories in dev-only tools (esbuild ≤ 0.24.2, glob, minimatch) | — | No |
| ARCH-08, -11, -12, -14; SEC-09–14 | I | Future / deferred | see reviewer reports | Runs repository split, endless detail polling, topology drift (now tested), folder layout; audit growth, `cn` package provenance, pinned images, auth/roles (OD-08b/OD-27), deletion and retention, SSRF and snapshot rendering for research | — | No |

Verified controls (both reviewers): workspace scoping on every query with uniform 404; HMAC playback per ADR-0033
(constant-time compare, expiry, ownership re-check, no-referrer, no-store); storage key containment; upload validation and
consent first; content-free logs and errors; zod config validation with production refusal of dev auth; loopback-bound
infrastructure; no fabricated report or evidence data; no paid or SaaS runtime dependencies (ADR-0034).

## 5. Acceptance recommendation (at validation time)

**Accept Phase 2A after P2A-01 is fixed** (the only failing gate), preferably together with P2A-02 and P2A-03. No Critical
findings, no code-level ADR violation and no security issue blocks a local development phase. ARCH-01 needs a user decision
on the documentation, not code.

## 6. Remediation (approved 2026-11-21) and revised register

### 6.1 Workstreams

- **R1 frontend:** P2A-01 fixed (`toolbar.tsx`: the count uses the chip's solid muted token). P2A-02, P2A-03 and ARCH-02 fixed
  with one shared module, `components/recording-frame.tsx` (overflow-safe page root, truncating breadcrumb with full name
  as text and `title`, shared loading / 404 with h1 / error states), used by recording detail, report and evidence.
- **R2 backend:** SEC-01 dev Host guard (`common/dev-host-guard.ts`, 403 `HOST_NOT_ALLOWED`, new contract error code);
  SEC-05 loopback-only `API_HOST` while `AUTH_MODE=dev`; SEC-04/ARCH-07 upload completion serialised on the recording row
  lock, part bodies staged without the lock and promoted in a short locked transaction (`StorageService.moveObject`), no
  second connection under the lock, committed originals never deleted; ARCH-10 `playback_stream_failed` logging (codes
  and IDs only; client disconnects ignored); SEC-07 filename rule rejects C1 and bidirectional controls.
  Opus security review, then two follow-up rounds: R2-01 (pool deadlock introduced by the first fix), R2-02, R2-03 /
  R2F-01, R2F-03, R2F-05, R2-07 fixed; final round reviewed in the Opus main session.
- **R3 documentation:** API spec per-endpoint status (Implemented / Partially / Designed only), HLD status line,
  DATABASE_DESIGN `total_parts`, LLD notes (Host guard, loopback, upload locking and staging, stream logging), SETUP
  `API_HOST`. **OD-48 (Open)** added: the AWS production target conflicts with ADR-0034; conflict flagged in HLD §2, SRS
  C-5 and DEPLOYMENT_ARCHITECTURE; ADR-0034 and the AWS design unchanged.
- Test fix: `e2e/navigation.spec.ts` made independent of list order (it failed when the upload spec added a recording).

### 6.2 Final results (newly executed after remediation)

| Check | Result |
| --- | --- |
| Unit: web / api / contracts / orchestrator / db | 170 / 165 / 30 / 3 / 4 passed |
| Integration: api / orchestrator / db | 15 / 4 / 7 passed (includes concurrent completes, part after completion, Host guard) |
| Lint, typecheck, audio tests and lint | Clean; audio 17 passed |
| E2E full suite (after R2 first round) | 57 passed, 1 failed (order-dependent test, then fixed), 10 skipped |
| E2E accessibility + dashboard + navigation (final) | 53 passed, 9 skipped by design, 0 failed |
| Browser audit after R1: 110 scans, 11 views × 5 widths × 2 themes | axe 0 everywhere (including `/recordings`); no overflow at any width, including recording detail at 360/412 px; one h1 on every view |
| `check:bundle` | All budgets met (recordings 171.4 / 175 render-critical, unchanged) |
| Smoke via preview proxy | List 200; signed playback Range 206; `Host: evil.example` 403 |

E2E upload tests added 4 synthetic recordings during this cycle in total (23 now). No data was deleted.

### 6.3 Revised findings register (open items only)

| ID | Sev | Type | Status / recommendation | Blocks |
| --- | --- | --- | --- | --- |
| ARCH-01 / OD-48 | H (docs) | Decision | Recorded as Open; needs a production deployment decision under ADR-0034 | No |
| SEC-02 + R2F-02 | M | Deferred production | Upload cleanup (expired sessions, staging and `.partial` orphans), per-recording in-flight cap, quotas, rate limits; depends on OD-10 / OD-09b | No |
| SEC-03 | L | Deferred | Consent statement version check; depends on OD-09b | No |
| R2-04 | L | Hardening | Further invisible characters (U+2028/9, U+FEFF, U+200B, U+2060–64, tags, U+00AD; keep U+200C/D), web-side filename pre-check, `<bdi>` around displayed filenames | No |
| SEC-06 | L | Hardening | Baseline security headers before any non-local deployment | No |
| SEC-08 | L | Tool config | `.claude/settings.json` deny-rule gaps: proposal to be presented before any change | No |
| R2F-04, R2F-05 (residual), R2-05, R2F-06 | I | Hardening / future | Conditional expiry writes; stricter Host parsing; S3 `moveObject` redesign | No |
| R2F-07 | I | Tests | Pool-size-1 integration test for the deadlock fix; `moveObject` / `markPartReceived` failure tests | No |
| P2A-04 | L | Accessibility (tool) | Axe while the Radix theme menu is open; no practical impact; recommend accept | No |
| ARCH-03, -04, -06*, -08, -09, -11, -12, -13, -14; DEP-01; SEC-09–14 | L/I | Debt / future / deferred | Unchanged from §4 (*ARCH-06 documented in R3) | No |

Resolved: P2A-01, P2A-02, P2A-03, ARCH-02, ARCH-05, ARCH-06 (documentation), ARCH-07, ARCH-10, SEC-01, SEC-04, SEC-05,
SEC-07 (as raised), R2-01, R2-02, R2-03 / R2F-01, R2F-03, R2-07. Not a defect: mobile sheet Escape / tooltip order.

### 6.4 Recommendation

All acceptance-blocking findings are resolved and every gate passes. **Recommend formal acceptance of Phase 2A**, with the
open items above tracked for later phases. Phase 2A is closed only on the user's approval.

## 7. Formal acceptance (2026-11-21)

The user approved formal acceptance of Phase 2A. M0 (baseline audit), M1 (design system and shell), M2 (dashboard), M3
(recording library), M4 (upload), M5 (recording detail), M6 (pipeline visualisation), M7 (reports workspace) and M8
(evidence exploration) are accepted, and consolidated validation is **passed**.

### 7.1 Final results (post-remediation, recorded as approved)

| Test category | Final result |
| --- | --- |
| Web unit tests | 170 passed |
| API unit tests | 165 passed |
| Contracts | 30 passed |
| Orchestrator | 3 passed |
| Database | 4 passed |
| Integration | 26 passed (API 15, orchestrator 4, database 7) |
| E2E | 53 passed, 0 failed |
| Lint | Clean |
| Typecheck | Clean |
| Audio tests and lint | Clean (17 tests passed; ruff, format and mypy clean) |
| Bundle budgets | All met; heaviest route 171.4 / 175 KB gzip render-critical (recordings) |

Scope note: the final E2E run covered the accessibility, dashboard and navigation specs (desktop and mobile; 9 skipped by
design). The upload-workflow spec was last run in the full suite after the first R2 round (§6.2) and was not re-run at
the end, to avoid creating more recordings; the final upload code is covered by the API unit and integration tests.

### 7.2 Development database

Four synthetic test recordings (`e2e-synthetic-{desktop,mobile}-<ts>.wav`) were added by the E2E upload tests during
the consolidated validation cycle. The development database contains **23 recordings**. No recordings were deleted and no
cleanup was performed.

### 7.3 Outstanding decisions and hardening (kept open)

- **OD-48** (Open): production deployment target under ADR-0034.
- Dependent on **OD-10 / OD-09b**: upload cleanup; leftover staged-part cleanup; upload limits; rate limiting;
  consent-version enforcement (SEC-02, R2F-02, SEC-03).
- **R2-04**: further filename character rules, browser-side filename validation and safe display of right-to-left
  filenames.
- **SEC-06**: baseline security headers.
- **SEC-08**: review of the Claude Code permission deny rules (a proposal will be presented before any change).
- The other Low and Informational items in §6.3.

### 7.4 What acceptance does and does not mean

Phase 2A acceptance means the frontend UI/UX implementation (M0–M8) and its consolidated validation are accepted. It does
**not** mean that production deployment is approved, that security hardening is complete, that authentication and
authorisation (OD-08b, OD-27) are resolved, that the production infrastructure decision (OD-48) is final, or that
retention, consent and rate-limiting decisions (OD-09b, OD-10) are settled. The platform is not production-ready. The
seven product agents and the audio-processing pipeline are not implemented.
