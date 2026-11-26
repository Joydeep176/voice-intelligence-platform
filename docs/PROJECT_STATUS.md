# Project status

Updated 2026-11-26 (Phase 2B and 2C formally accepted by the user; Phase 3A formally accepted the same day). Concise index; details live in the linked records.

| Phase / milestone | Status | Record |
| --- | --- | --- |
| Phase 1: platform foundation | Accepted | `docs/development/PHASE1_FOUNDATION.md` |
| Phase 2A M0–M8 (frontend redesign track) | **Accepted** (formally, 2026-11-21) | `docs/design/phase2a-*/README.md` |
| Phase 2A consolidated validation | **Passed** (post-remediation) | `docs/design/phase2a-validation/README.md` §6–§7 |
| Phase 2B: audio processing foundation | **ACCEPTED** (user acceptance, 2026-11-26) | `docs/development/PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`, `PHASE2B_COMPLETION.md` |
| Phase 2C: transcription and diarization foundation | **ACCEPTED** (user acceptance, 2026-11-26). Self-hosted providers: whisper.cpp small (ADR-0036), sherpa-onnx + CAM++ (ADR-0037), 2 CPUs (ADR-0041). Open: NFR-3/NFR-4 accuracy thresholds TBD (ADR-0042 Proposed); dense-speech limitation temporarily accepted; not tested: `pnpm test:phase2b:e2e` re-run, Graphify refresh, transcription over 2 h | `docs/development/PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`, `PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md` |
| Phase 3A: A1 Audio Quality Intelligence | **ACCEPTED** (user acceptance, 2026-11-26). Implemented and integrated (ADR-0043–0048; lifecycle deviations accepted as ADR-0044 Amendment 2). Evidence: unit, integration, browser E2E (11 categories), 2C transcript identity with A1 active, 4 h performance test, independent security and architecture reviews (0 blocking). Additional evidence: a real-world recording smoke test by the product owner (successful; not a comprehensive real-world accuracy validation). **Kept open:** AC-8 partially met (20 dB SNR MAE 3.05 dB against 2.0 dB; OD-55 Open); benchmark evaluation primarily synthetic; recording deletion and derived-file cleanup (privacy follow-up before production); measurement cancellation, backfill and the snapshot `measurementSet` field not implemented | `docs/development/phase3a/PHASE3A_COMPLETION_REPORT.md`, `PHASE3A_REQUIREMENT_EVIDENCE_MATRIX.md` |
| Agent phase | Not approved | — |

## Phase 2B in one paragraph

Implemented: sandboxed audio service (contract v2, bearer auth per ADR-0035, Landlock-confined FFmpeg children), probe
and validation of new uploads, explicit-request preprocessing (canonical 16 kHz mono WAV, timeline mapping, objective
measurements, VAD-agnostic segmentation with **no VAD selected**), migration `0002_audio_processing` (applied to the dev
database 2026-11-21 after a backup), orchestrator step-jobs with bounded retries and deadlines, processing API, and the
recording-detail processing card. Validation results, benchmarks, reviews and residual risks: `PHASE2B_COMPLETION.md`.

Validation: the unit, integration, Python, Compose-hardening and real-stack E2E suites passed in the consolidated run of
2026-11-21 (`PHASE2B_COMPLETION.md` §2). Closure pass 2026-11-22: build, lint and typecheck pass; all bundle budgets met;
full web Playwright suite **95 passed, 0 failed, 11 skipped** (isolated `*_test` database); separately, the desktop
navigation journey (skipped in the full run for lack of test data) passed 5/5 when re-run with data. `pnpm format:check` fails on 89 pre-existing tooling files (`.agents/`,
`.codex/`, `AGENTS.md`), none of them Phase 2B files.

## Decision status (nothing below is accepted unless stated)

| Item | Status |
| --- | --- |
| D-2B-08 networking (ADR-0035), OD-23b | Accepted (user decision) |
| OD-02b STT / OD-03b diarization providers | Accepted (selection delegated by the user, 2026-11-24): ADR-0036 / ADR-0037. NFR-3 / NFR-4 thresholds: **undecided**; deferral proposed in ADR-0042, awaiting the user's decision |
| ADR-0034 hardware correction (M1, 8 GB, 512 GB) | Applied (user instruction); decision unchanged |
| D-2B implementation decisions | Accepted as built (ADR-0040) |
| OD-10 limits/timeouts; D-2B-18 to -20 (incl. the memory-gate definition) | Accepted (ADR-0039); CPU and threads amended by ADR-0041 (accepted, confirmed 2026-11-26) |
| OD-29 VAD selection | Accepted: Silero VAD spans inside transcription windows (ADR-0038) |
| OD-18 datasets, OD-39 waveform peaks (deferral) | Accepted (ADR-0040) |
| OD-16 transport, OD-23c, OD-48, OD-47, OD-05 | Open / Proposed as registered in HLD §10 |
| ADR-0002 / ADR-0023 / ADR-0018 | OD-04a and OD-23a Accepted; OD-04b and ADR-0018 Accepted provisionally (ADR-0040) |
| ADR-0040 | Corrected 2026-11-26 (user direction): it records the closure decision items; the phases were accepted separately by the user on 2026-11-26 |

## Development data

Development database: **27 recordings** (verified 2026-11-22).

| Group | Count | State |
| --- | --- | --- |
| Pre-existing (before Phase 2B) | 23 | 22 rows identical to the pre-migration backup. One (`04adac16…`) had **processing metadata populated** by an explicit processing request on 2026-11-21 (status, duration, sample rate, channels, probe record, plus a preprocessing version and derived files); its **identity is unchanged** (workspace, filename, storage URI, recorded SHA-256, MIME type, size, created_at) and its original file is not modified by processing (read-only mount; recorded SHA-256 unchanged) |
| Synthetic test uploads added 2026-11-21 | 4 | Added by the Phase 2A web Playwright suite while it targeted the dev API; validated automatically as new uploads; kept |

22 of the 23 pre-existing rows carry `e2e-synthetic-*` filenames from earlier E2E runs. Backup:
`.local-backups/pre-0002-*.dump`. Details: `PHASE2B_COMPLETION.md` §8.

## Production readiness

**Not production-ready.** Open: OD-48 production deployment target (ADR-0034); OD-08b/OD-27 authentication and
authorisation; OD-23c production service authentication; OD-09b/OD-10 retention, consent version, upload limits,
cleanup and rate limiting; R2-04 filename hardening; SEC-06 security headers; SEC-08 permission deny-rule review;
deletion of recordings and their derived audio, including A1 measurement series (no deletion endpoint yet; privacy and
retention follow-up before launch).

Key constraints: ADR-0034 zero additional spending; all open decisions are in `docs/architecture/HLD.md` §10.

Baseline: commit `b3c90f5` on `main` (Phase 1, 2A, 2B and 2C are committed). All Phase 3A work is **uncommitted** in
the working tree; the user commits manually.
Graphify graph refreshed 2026-11-26 against the working tree (`graphify update .`, code only, no LLM; 5,577 nodes,
16,372 edges, 217 communities, no import cycles; `graphify-out/`, gitignored). SQL migrations are not parsed (the
optional SQL grammar is not installed). Architectural review: `docs/development/phase3a/PHASE3A_COMPLETION_REPORT.md` §6.

## Where to find things

| Topic | Record |
| --- | --- |
| Requirements | `docs/SRS.md` |
| Architecture, approved stack, decisions register (OD-xx) | `docs/architecture/HLD.md` (§2 stack, §10 register) |
| Decisions | `docs/architecture/adr/` (ADR-0001 … ADR-0035) |
| Modules, internal audio API, queues | `docs/architecture/LLD.md` |
| Schema, API, deployment, testing, agents | `docs/architecture/{DATABASE_DESIGN,API_SPECIFICATION,DEPLOYMENT_ARCHITECTURE,TESTING_STRATEGY,AGENT_ARCHITECTURE}.md` |
| Phase 1 | `docs/development/PHASE1_FOUNDATION.md` |
| Phase 2A | `docs/design/phase2a-*/README.md`, `docs/design/phase2a-validation/README.md` |
| Phase 2B | `PHASE2B_COMPLETION.md` (authoritative), `PHASE2B_SCOPE.md` (original scope + follow-up), `PHASE2B_PLAN_DRAFT.md` (revision 4, historical), `PHASE2B_PROGRESS.md` (archived log), evidence folders `phase2b-*/`, `services/audio/VERIFICATION_*.md` |
| Setup, environment variables, commands | `docs/development/SETUP.md`, `CLAUDE.md` |
| Model routing for dev agents | `docs/development/MODEL_ROUTING.md` |
| Code relationships | Graphify (`graphify query`, `affected`, `path`, `explain`; refresh with `graphify update .`) |
