# Project status

Updated 2026-11-21. Concise index; details live in the linked records.

| Phase / milestone | Status | Record |
| --- | --- | --- |
| Phase 1: platform foundation | Accepted | `docs/development/PHASE1_FOUNDATION.md` |
| Phase 2A M0–M8 (frontend redesign track) | **Accepted** (formally, 2026-11-21) | `docs/design/phase2a-*/README.md` |
| Phase 2A consolidated validation | **Passed** (post-remediation) | `docs/design/phase2a-validation/README.md` §6–§7 |
| Phase 2B: audio processing foundation | Approved in scope; **not authorised to begin** | `docs/development/PHASE2B_SCOPE.md` |
| Agent phase | Not approved | — |

Final Phase 2A results: web unit 170, API unit 165, contracts 30, orchestrator 3, database 4, integration 26 (each
passed); E2E 53 passed, 0 failed; lint, typecheck, audio tests and lint clean; all bundle budgets met (heaviest route
171.4 / 175 KB gzip).

Development database: 23 recordings, including four synthetic recordings added by E2E tests during Phase 2A validation.

Implemented: consented, resumable upload with signature validation (lock-serialised completion, staged parts); local
storage; run record at upload (`created`); signed playback (ADR-0033); health; development Host guard and loopback-only
binding while authentication is off; web app with dashboard, recordings, upload, recording detail, pipeline
visualisation, reports workspace and evidence workspace (honest unavailable states).

Not implemented (designed only): preprocessing in the audio service, the seven product agents, transcripts, analysis,
research, validation, reports and exports, authentication and authorisation.

**Not production-ready.** Phase 2A acceptance covers the frontend and its validation only. Open: OD-48 production
deployment target (ADR-0034); OD-08b/OD-27 authentication and authorisation; OD-09b/OD-10 retention, consent version,
upload limits, cleanup and rate limiting; R2-04 filename hardening; SEC-06 security headers; SEC-08 permission deny-rule
review.

Key constraints: ADR-0034 zero additional spending (production LLM inference OD-47, research provider OD-05 and production
deployment target OD-48 are Open); all open decisions are in `docs/architecture/HLD.md` §10.

Working tree: all work since `f8686a3` (M7, M8, ADR-0034, Phase 2A validation, remediation and records) is uncommitted.
