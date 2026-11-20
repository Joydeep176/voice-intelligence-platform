# Phase 2A · M7 handoff: Reports Workspace

End-of-day checkpoint, 2026-11-20. **M7 has not started.** No M7 planning or implementation was done. Resume tomorrow
with the M7 Opus planning pass, using this document and the refreshed Graphify output (`graphify-out/`).

## 1. Project status

| Milestone | Status | Record |
| --- | --- | --- |
| Phase 1: platform foundation | Completed and accepted | `docs/development/PHASE1_FOUNDATION.md` |
| Phase 2A M0: baseline audit | Completed | `docs/design/phase2a-m0-baseline/README.md` |
| M1: design system and application shell | Accepted | `docs/design/phase2a-m1/README.md` |
| M2: premium AI dashboard (3D hero) | Accepted | `docs/design/phase2a-m2/README.md` |
| M3: recording library | Accepted (its dedicated tests are deferred to the phase-level cycle) | — |
| M4: upload experience | Accepted | — |
| M5: recording detail workspace and signed playback | Accepted | `docs/design/phase2a-m5/README.md` |
| M6: seven-agent pipeline visualisation | **Accepted and closed** | `docs/design/phase2a-m6/README.md` |
| **M7: reports workspace** | **Not started** | this document |
| M8: evidence exploration | Not started | — |

Repository state at the checkpoint:
- HEAD is `6394cf7`, the user's own commit at 19:36.
- Work since then (M5, M6, the routing tooling and others) is **uncommitted**.
- Claude has made **no commits or pushes**.
- Untracked `.agents/`, `.codex/` and `AGENTS.md` (created 20:08 by an external tool) are not project work. Leave them alone. They are excluded from Graphify.

## 2. Approved architecture (do not change without approval)

- **Seven product agents** (ADR-0001, ADR-0019), plus a deterministic preprocessing stage (audio service; not an agent):
  - A1 Audio Quality;
  - A2 Transcription (incl. language ID, diarization, uncertainty);
  - A3 Context Intelligence;
  - A4 Research;
  - A5 Fact Validation;
  - A6 Reporting;
  - A7 QA (independent, read-only).
- **Execution dependencies** (AGENT_ARCHITECTURE §2):
  - preprocessing forks into A1 ∥ A2 (ADR-0021);
  - A2 → A3 → A4 → A5, with exactly one targeted A5 → A4 research retry (ADR-0014);
  - **A6 waits for A1 and A5** (the only join);
  - A6 → A7. The A7 → A6 revision loop is OD-14, *Proposed*.
- **Provenance:** every report assertion carries `recorded` (from the recording), `external` (research evidence) or
  `inferred` (AI interpretation). They must stay visually and structurally distinct.
  - Verdicts use snapshot evidence, never snippets.
  - Audio diagnostics stay separate from transcription uncertainty (FR-9.3).
  - Brand accents never appear on evidence surfaces (ADR-0030).
- **ADRs 0001–0033 are in force.** Most relevant to M7:
  - ADR-0006 (report formats and language);
  - ADR-0007 (immutable provider output, versioned corrections);
  - ADR-0017 (research adapter);
  - ADR-0030 (brand vs semantic colours);
  - ADR-0026 to ADR-0029 and ADR-0031 to ADR-0032 (frontend stack: Motion, three.js hero without R3F, IBM Plex, axe);
  - ADR-0033 (signed playback; its pattern is the model for any future signed export download).
- **Open or Proposed decisions** that M7 must not resolve implicitly:
  - OD-08b (authentication) and OD-27 (authorisation);
  - OD-25 (export tooling);
  - OD-14 (QA revision loop);
  - OD-16 (progress transport, *Proposed* SSE);
  - OD-36 (charting library: none approved).

## 3. Reports: what actually exists (verified in source 2026-11-20)

- **No report infrastructure is implemented.**
  - No report schemas in `packages/contracts`.
  - No report, assertion, evidence or export tables in `packages/db`.
  - No report routes in `apps/api`.
  - The orchestrator runs only the Phase 1 foundation-check worker.
  - A6 Reporting and A7 QA are not implemented.
- **Designed only** (API_SPECIFICATION):
  - `GET /runs/{runId}/report?version=` (a structured report model with provenance per assertion);
  - `GET /runs/{runId}/report/qa`;
  - `POST /runs/{runId}/report/exports` (`pdf|docx`; tooling OD-25);
  - `GET /runs/{runId}/report/exports/{exportId}` (signed, audited download).
- **Real data available today:** recordings, run records (status `created` only), health, signed playback.
- **Rule for M7:** never fabricate reports, sections, findings, evidence, report statuses, versions or export
  capability. Unavailable means an honest "not available yet" state.
  - Any backend addition (report contracts, endpoints, fixtures) needs the user's approval first.
  - Synthetic demo content is a decision for the user, not a default.

## 4. M7 scope to investigate and plan (not approved for implementation yet)

1. Reports listing and organisation.
2. Report detail and reading experience.
3. Executive summaries.
4. Findings and structured report sections.
5. Evidence and source references, where real data exists.
6. Report status and version information.
7. Export experience, subject to actual backend capability (none today; OD-25).
8. Responsive desktop, tablet and mobile layouts.
9. Dark and light themes.
10. Accessibility (axe 0 violations, keyboard, reduced motion) and performance.

## 5. Performance budgets (latest approved: user decision 2026-11-20, end of M6)

| Budget (gzip) | Limit |
| --- | --- |
| Render-critical JS | **175 KB** |
| Combined route JS (render-critical + deferred Motion) | **205 KB** |
| Route-specific chunk | **30 KB** |
| Deferred Motion | **20 KB** |
| CSS | **20 KB** |
| Deferred 3D | **250 KB** (0 bytes on first paint, mobile, reduced motion, no WebGL) |

Enforced by `pnpm --filter @vip/web check:bundle` (`apps/web/scripts/check-bundle.mjs`). Canonical table: M0 README §5.
There is no CI yet (OD-17).

Latest measurements (M6 final, KB gzip):

| Route | Render-critical | Combined | Own chunk |
| --- | --- | --- | --- |
| pipeline | 171.6 | 189.9 | 7.3 |
| dashboard | 171.4 | 189.7 | 6.1 |
| upload | 171.2 | 189.5 | 6.6 |
| recording-detail | 170.1 | 188.4 | 4.8 |
| recordings | 169.6 | 187.9 | 4.1 |
| not-found | 163.7 | 182.0 | 0.4 |

Other measurements: 3D hero chunk 130.0 / 250; CSS 13.9 / 20; deferred Motion 18.3 / 20; preloaded fonts 1 file, 67.4 / 80.

**The binding constraint is render-critical 175.** Combined cannot exceed 195 while render-critical and Motion pass. A
new route has about 3.4 KB of room before shared-code savings. Measure every route; `check:bundle` prints only the
heaviest. The per-route script used in M5 and M6 is in the M6 delegation prompts (manifest closure plus gzip).

## 6. M7 planning opportunity: shared-shell bundle assessment

The shared initial bundle is about 163.5 KB (the not-found route's render-critical total, before M6 it was 163.5 and now
163.7). Assess in the M7 Opus pass whether interaction-only shell elements can load on first use:
- the mobile navigation sheet (Radix Dialog);
- the theme dropdown menu;
- tooltips (collapsed rail and status);
- any other UI not needed for first render.

Quantify the savings per route before proposing anything. **This is an assessment only, not approval for a shell
redesign.** Shell changes affect the M1 deliverable and need the user's approval.

## 7. Development workflow (binding)

- **Planning:** one Opus 5.5 planning pass. It inspects source, presents scope, acceptance criteria, reuse, file ownership,
  performance strategy and blockers (anything needing backend or an Open/Proposed decision goes to the user first).
- **Implementation:** one explicitly modelled Sonnet 5.5 developer at a time, sequential, with declared `Owned files:`.
  No parallel implementation agents. Follow the `model-router` skill. Use `[opus-review-follows]` only for genuine
  Sonnet implementation under an Opus plan, with the Opus review scheduled.
- **Verification:** the main session verifies in a real browser (production build via `vite preview`, live API):
  screenshots in `docs/design/phase2a-m7/screenshots/`, axe, keyboard, responsive overflow, per-route budgets.
- **Testing:** no test-engineer, test-strategist or reviewer agents per milestone. Phase-level testing plus Opus
  architecture, security and performance reviews run **after all Phase 2A implementation milestones**, when the user
  declares Phase 2A complete. Priority items for that cycle are listed in `docs/design/phase2a-m5/README.md` §7.
- **Data:** avoid E2E runs that create synthetic recordings. Never read `.env`, root `storage/`, `.local-storage/` or `data/`.
- **Git:** no commits or pushes without explicit permission. **Stop after M7 for user acceptance; do not begin M8
  without approval.**

## 8. Environment notes for resuming

- **Services:** Postgres and Redis run in Docker. Docker's CLI is at `/Applications/Docker.app/Contents/Resources/bin/docker`;
  it was not on the shell PATH. The API (`pnpm --filter @vip/api dev`, port 3000) needs `MEDIA_URL_SIGNING_SECRET` in the
  root `.env`, which is present (never display it). Audio service: `pnpm audio:dev` (port 8001). Preview:
  `pnpm --filter @vip/web preview` (port 4173).
- **Permissions:** `.claude/settings.json` deny rules `/storage/**` and `/data/**` are anchored to the repo root
  (user-approved 2026-11-20). Application source folders named `storage` or `data` are readable.
- **Graphify:** refreshed 2026-11-20 against commit `6394cf72` (code only, no LLM): 1,671 nodes, 3,570 edges, 94
  communities. See §9.

## 9. Graphify refresh (2026-11-20)

- `graphify update .` rebuilt the code graph. It now includes M5 (playback module, storage range reads, audio player)
  and M6 (pipeline topology and page). The previous graph was backed up automatically to `graphify-out/2026-11-20/`.
- `.graphifyignore` now also excludes `.agents/`, `.codex/` and `AGENTS.md`. Without it the external folders added 785
  nodes and broke the documented code-only convention.
- Known limitations:
  - The two SQL migrations are not parsed (`tree_sitter_sql` is not installed).
  - 18 files (specs and configs) yield no symbols.
  - Community names are hub-derived: `graphify label` needs an LLM, which the dev-tooling rule excludes.
  - Doc and image changes are not semantically extracted (code-only build).
