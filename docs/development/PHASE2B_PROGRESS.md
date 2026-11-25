# Phase 2B · progress record (ARCHIVED)

**Archived 2026-11-22.** This was the working log used while Phase 2B was executed (2026-11-21), including a pause for
the token budget and the resume. It is kept as historical evidence only. **The authoritative record is
`PHASE2B_COMPLETION.md`**; current project state is in `docs/PROJECT_STATUS.md`. Nothing here is a decision.

## Workstream history (final state)

| WS | Scope | Outcome | Evidence |
| --- | --- | --- | --- |
| 0 | Doc corrections (DATABASE_DESIGN measurement writer → ADR-0019), ADR-0035 (D-2B-08, user decision), ADR-0034 hardware amendment (user instruction) | Done | `adr/0035-*`, `adr/0034-*` Amendment |
| 1 | Contracts v2, bearer auth, task executor, storage backend, sandboxed runner, Landlock, Compose hardening | Done; Opus-reviewed | `services/audio/VERIFICATION_WS1.md` |
| 2 | Migration `0002_audio_processing`, repository functions | Done; SQL Opus-reviewed; applied to the dev DB 2026-11-21 after a `pg_dump` backup | `DATABASE_DESIGN.md` §4; `.local-backups/` |
| 3 | Probe, streamed decode, timeline mapping, NumPy, malicious-media tests | Done; Opus-reviewed | `VERIFICATION_WS3.md`, `docs/development/phase2b-timestamps/` |
| 4 | Measurements, canonical WAV, EBU R128, `preprocess` task | Done; Opus-reviewed | `VERIFICATION_WS4.md` |
| 5a | VAD candidate benchmark (synthetic TTS corpus) | Done (interrupted by the pause; report stage re-run on resume) | `docs/development/phase2b-vad-benchmark/` |
| 5b | VAD adapter | **Not done: blocked on the user's VAD selection (OD-29)** | — |
| 6 | VAD-agnostic segmentation (no VAD registered) | Done; Opus-reviewed | `services/audio/tests/test_segmentation_*` |
| 7 | Orchestrator coordinator, API endpoints, upload-triggered probe | Done (interrupted by the pause, finished on resume, tested, remediated) | `apps/orchestrator/src/processing/`, `apps/api/src/processing/`, int-specs |
| 8 | Frontend processing card | Done | `docs/design/phase2b-processing-ui/README.md` |
| 9 | Real-stack E2E, M1 resource benchmarks | Done | `tests/phase2b-e2e/`, `docs/development/phase2b-resources/` |
| 10 | Opus architecture and security/data-integrity reviews; remediation of all findings | Done | `services/audio/VERIFICATION_REMEDIATION.md`; `PHASE2B_COMPLETION.md` §5 |
| 11 | Docs, Graphify refresh, completion record; closure pass 2026-11-22 | Done | `PHASE2B_COMPLETION.md` |

## Superseded notes

- The resume steps that were here (2026-11-21) were executed and are obsolete.
- An earlier note said the `mjpeg`/`png` decoders are "never decoded". **That was wrong**: FFmpeg's stream-info pass
  opens them for attached cover art. Corrected in `VERIFICATION_WS1.md`, `VERIFICATION_WS3.md` and the plan §6; recorded
  as a residual risk in `PHASE2B_COMPLETION.md` §6.
- The loudness-summary concern (64 KiB stderr window on huge tag dumps) was not reproduced; it remains a noted risk.
