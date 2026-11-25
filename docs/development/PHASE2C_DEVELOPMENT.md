# Phase 2C · transcription and diarization foundation — development record

Status: **in development** (started 2026-11-22, user brief). Not accepted. Nothing committed.
Completion pass 2026-11-24: `PHASE2C_COMPLETION_AUDIT.md` (audit) and `PHASE2C_COMPLETION_REPORT.md` (fixes and validation). The text below is the original record; corrections are in the last section, not edited in place.

## Scope (user brief, 2026-11-22)

Provider-neutral STT and diarization interfaces; transcription with timestamped segments; speaker diarization within a
recording; immutable provider output, timestamps and provenance; multilingual (en / hi / Hinglish) subject to the provider's
real capabilities; persisted jobs, states, results, errors and versions; NestJS API; recording-detail UI; progress and
failure states. **Out of scope:** the seven agents, LangGraph, context intelligence, research, fact validation, reports,
paid services (ADR-0034).

## Governing records

ADR-0007 (immutable provider output, versioned corrections, separate speaker display names), ADR-0012 (fake adapters
first; benchmark before selection), ADR-0015 (transcription is run-scoped), ADR-0016 (bounded-memory diarization),
ADR-0019 (transcription separate from audio diagnostics), ADR-0025 (run created at upload, `created` → `queued` on
submission), ADR-0014 (run control), ADR-0034 (zero spending). DATABASE_DESIGN §4 transcript tables; API §5; LLD §3.2.

## Interim implementation decisions (Phase 2C; for the user's later confirmation — not accepted)

| ID | Decision | Why |
| --- | --- | --- |
| D-2C-01 | Without LangGraph, the orchestrator coordinator executes a run with an explicit **stage scope** (`transcription`, `diarization`), recorded in the run's config snapshot; stages tracked in `pipeline_stage_runs`; run status `created → queued → running → completed / failed / cancelled` (ADR-0025, ADR-0014). `completed` means the scoped stages completed, never the full pipeline; the UI states the scope. LangGraph replaces the coordinator later | Follows the run-scoped design without implementing agents or a graph |
| D-2C-02 | Transcription input: the preprocessing version's VAD segments when they exist; otherwise **fixed windows** over the canonical audio (interim OD-10 values: 30 s windows, 1 s overlap). The window source is recorded on every transcript | No VAD is selected (OD-29), so Phase 2B produces no segments |
| D-2C-03 | Providers: **fake** STT and diarization adapters (OD-02a / OD-03a Interim, ADR-0012) drive the pipeline end to end. Their output is visibly marked as fake and carries no confidence. Real local candidates are benchmarked; **the user selects** (OD-02b / OD-03b) before any real adapter becomes a runtime dependency | Project rule: real providers need user approval and an ADR |

## Workstreams

| # | Workstream | Agent | Status |
| --- | --- | --- | --- |
| C1 | Contracts, migration `0003_transcription`, repositories, orchestrator run coordinator with fake providers, API endpoints, tests | backend-engineer (Sonnet) | Done 2026-11-22. Migration reviewed by the main session (Opus) and **applied to the dev DB** after backup `.local-backups/pre-0003-*.dump`; recordings (27) and runs (27) fingerprints unchanged |
| C2 | Recording-detail transcript and speaker UI | frontend-engineer (Sonnet) | Done 2026-11-22 (web 259 tests; Playwright 32 mocked-network; budgets met). The Phase 2A placeholder `components/recording/transcript-card.tsx`, orphaned by C2, was removed |
| C3 | Local STT and diarization candidate benchmark (licence, M1 resources, synthetic en/hi/Hinglish corpus) → user selection | backend-engineer (Sonnet) | **Partial**: accuracy and dependency evidence done; resource measurements (RTF, memory, 512 MB feasibility, long files) still running in a background queue; two jobs (whisper.cpp medium accuracy, WeSpeaker diarization) were lost to an accidental kill and are re-queued |

## Results

### C1 · backend foundation (implemented 2026-11-22; not accepted; nothing committed)

**What exists.** Fake STT and diarization adapters drive a run end to end: `POST /recordings/{id}/runs` → `run-transcription` job → windows (VAD segments if the preprocessing has any, else fixed 30 s / 1 s overlap) → per-window raw output stored first (atomic write, sha256, `stt_raw_outputs`) → overlap stitching → whole-file diarization (raw output stored first) → speaker alignment and uncertainty spans → transcript v1 persisted in one transaction → run `completed`. Output is marked `fake` in the run snapshot and carries no confidence. No agents, LangGraph, real provider, new dependency or paid service.

**Files.**
- Contracts: `packages/contracts/src/transcription.ts` (adapter interfaces, run config, DTOs), `jobs.ts` (queue names `run-transcription` / `run-sweep`, `RunTranscriptionJob`, `JobIds.run`), `index.ts`, `transcription.test.ts`, `fixtures/transcription/*.json`.
- DB: `packages/db/src/schema.ts` (new tables, `pipeline_runs` additions), `src/transcription.ts` (repository), `src/index.ts`, `drizzle/0003_transcription.sql` + `meta/0003_snapshot.json` + `_journal.json`, `test/transcription.int.test.ts`; `test/db.int.test.ts` (migration count 3 → 4) and `test/audio-processing.int.test.ts` (the 0002 byte-identity snapshot now excludes the three nullable `pipeline_runs` columns that 0003 adds, as it already excluded `media_probe`).
- Orchestrator: `src/providers/{errors,raw-store,clock,registry}.ts`, `providers/stt/fake.ts`, `providers/diarization/fake.ts`, `src/runs/{types,windowing,stitch,align,progress,queues,run.step,run.workers,sweeper}.ts`, `src/config.ts` (+ spec), `src/orchestrator.module.ts`, specs and `test/runs.int-spec.ts`.
- API: `src/runs/{run-audit,run.mapper,runs.service,runs.controller,runs.module}.ts`, `src/transcripts/*`, `src/queue/{run-queues.producer,run-settings,queue.module}.ts`, `src/app.module.ts`, specs and `test/runs.int-spec.ts`.
- `.env.example` (variable names only), DATABASE_DESIGN, API_SPECIFICATION §3 and §5, LLD §3.2 and §5.

**Migration `0003_transcription` (additive; for `data-integrity` review).** Generated by `drizzle-kit`, then hand-ordered so the `(id, workspace_id)` unique indexes exist before the composite FKs, with hand-appended triggers (like 0002). `pipeline_runs` + `preprocessing_id` (composite FK), `config` jsonb, `cancel_requested_at`; new tables `pipeline_stage_runs`, `stt_raw_outputs`, `diarization_raw_outputs`, `transcripts`, `transcript_versions`, `speakers`, `transcript_segments`, `transcription_uncertainties`. Triggers: UPDATE blocked on raw outputs, versions and segments; `speakers.speaker_key` (and transcript/workspace) immutable, `display_name` editable. Verified on a fresh database and on a database populated at 0002 (existing rows identical, new columns NULL); `drizzle-kit generate` reports no drift. Applied only to the disposable `_test` database; the development database was not touched.

**Endpoints.** `POST /recordings/{id}/runs`, `GET /runs/{runId}` (superset of the old snapshot), `POST /runs/{runId}/cancel`, `POST /runs/{runId}/retry`, `GET /runs/{runId}/transcript/versions`, `GET /runs/{runId}/transcript` (versions, time range, keyset-paged), `GET /runs/{runId}/transcript/uncertainties`, `GET /runs/{runId}/transcript/raw` (metadata only), `GET /runs/{runId}/speakers`, `PATCH /runs/{runId}/speakers/{speakerId}` (all under `/workspaces/{workspaceId}`). Details: API_SPECIFICATION §3 and §5.

**Tests (actual counts).** Contracts 149 (11 new, `transcription.test.ts`). DB unit 5, DB integration 54 (20 new: migration on fresh and 0002-populated databases, composite FKs and CHECKs, immutability triggers, atomic idempotent and concurrent v1 persistence, rollback, guarded transitions, sweeper compare-and-set, stage rows, raw first-write-wins, workspace isolation). API unit 211 (16 new) and integration 67 (28 new: preconditions, idempotent and concurrent submission, snapshot, cancel, retry and limit, transcript paging, workspace isolation on every read, speaker rename and audit, not-implemented routes). Orchestrator unit 71 (36 new: windowing incl. VAD path, stitching, alignment, uncertainty generation, fake determinism and raw hash, progress throttle, registry, config, sweeper decision) and integration 58 (16 new: real BullMQ + test DB + fake providers + throwaway storage: submit to completed with traceable raw outputs, VAD windows, scope without diarization, idempotent re-enqueue, cancel mid-run, retry after injected failure with stored windows reused, transient retry by the queue, attempts exhausted, precondition failure, deadline, provider timeout, three sweeper recoveries, unknown provider key). Web 204 (no regression). `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass; `pnpm format:check` lists 90 files, none from this change (the rest are earlier uncommitted work).

**Deviations and limitations.**
- `apps/api/src/config/app-config.ts` is outside the C1 file list, so `RUN_MAX_RETRIES`, `QUEUE_RUN_ATTEMPTS` and `QUEUE_RUN_BACKOFF_MS` are read and validated by `apps/api/src/queue/run-settings.ts` (same names as the orchestrator). Moving them into `AppConfig` is a small follow-up. The API audit module is also not in the list, so run and speaker audit events use `src/runs/run-audit.ts` (same table, same IDs-only rule).
- `stt_raw_outputs` has `window_index` and window bounds instead of the designed `segment_id` (fixed windows have no `audio_segments` row).
- Stitching is segment-level (midpoint ownership); word-level selection (LLD §4 step 6) needs a provider that returns words.
- The orchestrator runs the whole scope in one job, not one job per window (`stt-segment` / `stt-complete`), and cannot abort an in-flight provider call (its result is discarded). A retry reuses stored raw output but re-calls the provider for a window with no stored output.
- The sweeper counts a recovery as a retry (bounded by `RUN_MAX_RETRIES`); a user retry and a recovery share the same budget.
- Diarization is whole-file only (ADR-0016 windowed mode and cross-window speaker matching are interface hooks only). Only `overlapping_speech` and `speaker_uncertain` are generated.
- Raw output signed URLs are not implemented (metadata and `sha256` only). Correction versions, derivations, `GET /runs/{runId}/events`, `hasLimitations` and cost are not implemented.
- `transcription_uncertainties` is not immutable (not listed in the design).
- Interim values (30 s / 1 s windows, `RUN_MAX_RETRIES=3`, 1 h deadline, 120 s provider bound) are OD-10 placeholders, not decisions.

### C2 · transcript, speakers and run progress UI (implemented 2026-11-22; not accepted; nothing committed)

Design notes: `docs/design/phase2c-transcription-ui/README.md`. Code: `apps/web/src/components/transcription/**`, mounted in `pages/recording-detail.tsx` in place of the placeholder `TranscriptCard` (now unused, left in place); `processing-card.tsx` gained an optional `onStateChange` and exports `Pill` / `ProgressBar`.

**Tests.** Web 259 (was 204; 55 new: transcript-section 44 incl. each run state, per-stage progress, fake banner, Devanagari and `lang`, null confidence, uncertainty, paging, rename success/422/409, polling start/stop/pause, retry visibility; model 11). Playwright, mocked network and Vite only (scratch config, not `pnpm test:e2e`): 32 passed (desktop and mobile; start to completed with rename; axe on seven states in light and dark; phone-width overflow). One dark-theme `cancelled` axe run failed once in the first full pass and was not reproduced in 84 later dark runs (cause not isolated).

**Bundle.** Route chunk `recording-detail` 12.2 KB gz (limit 30); render-critical 172.7 KB (175); combined 191.0 KB (205); CSS 14.3 KB (20).

**Deviations.** No timestamp-to-audio seek (no seek hook). Language tags show names (English, Hindi, Mixed). Uncertainty spans are fetched for the loaded range only (up to 5 cursor pages).

### C3 · local candidate benchmark (partial, 2026-11-22; no provider selected)

Evidence: `docs/development/phase2c-stt-benchmark/` (README with a STATUS section marking missing parts, DEPENDENCIES.md,
results.json). Synthetic macOS-TTS corpus only (10 sentences per language for the medium models): **not evidence of
real-world accuracy**; differences of a few points are noise.

| Engine (licence) | English WER clean / 10 dB | Hindi CER clean / 10 dB |
| --- | --- | --- |
| faster-whisper small (MIT) | 3.1 / 10.0 | 17.3 / 19.5 |
| faster-whisper medium (MIT) | 2.3 / 2.3 | 10.7 / 13.7 |
| whisper.cpp small q5_1 (MIT) | 3.1 / 9.2 | 16.8 / 20.6 |
| sherpa-onnx Whisper small (Apache-2.0 runtime, MIT weights) | 3.1 / 10.0 | 16.5 / 18.4 |
| sherpa-onnx Whisper medium | 1.5 / 6.2 | 13.2 / 14.0 |
| Omnilingual 300M CTC (Apache-2.0) | 21.5 / 25.4 | 8.8 / 15.4 |

Hinglish: Devanagari-mixed WER ≈ 37–48 % clean; romanised references score > 100 % by construction (engines output
Devanagari; no transliteration applied). Diarization (sherpa-onnx + CAM++ embeddings, 250 ms collar): DER 14.7 / 21.4 /
6.1 % for 2 / 3 / 4 speakers with a dev-tuned threshold (over-clusters: speaker count exact in 1 of 3 conversations per
count); 3.1 / 2.8 / 3.1 % with the oracle speaker count. Overlap < 1 % of reference speech, so overlap handling is barely
tested. Excluded: pyannote.audio (PyTorch, gated models), AI4Bharat/NeMo (PyTorch/NeMo), Whisper large (memory).
Licence flag: faster-whisper depends on PyAV, which bundles GPL codecs (libx264/libx265) — needs review if selected.
**Resource results (RTF, anonymous memory, 512 MB feasibility) are pending**; `docker stats` showed ≈ 1.3 GiB (Omnilingual)
and ≈ 2.7 GiB (faster-whisper medium) including page cache — indicative only, not measurements.

## Reconciliation notes (2026-11-24, completion pass)

Added after the completion audit. Earlier sections are left as written; where they conflict, these notes reflect the
verified repository state.

- **Migration 0003 and the development database.** The C1 results say "Applied only to the disposable `_test`
  database; the development database was not touched" (written when C1 finished). The workstream table records the
  later step: applied to the dev DB after a backup. The backup `.local-backups/pre-0003-20261122T105819.dump` and
  `pre-0003-fingerprint.txt` exist, which supports the later entry. The dev database itself could not be inspected on
  2026-11-24 (Postgres not running).
- **`TranscriptCard`.** C2 says the Phase 2A placeholder was "now unused, left in place"; the workstream table says it
  was removed. It is removed: `apps/web/src/components/recording/transcript-card.tsx` is deleted in the working tree and
  nothing references it (typecheck passes).
- **C3 benchmark.** The background queue finished the resource runs on 2026-11-23, but the results were not folded into
  `results.json`; the whisper.cpp medium accuracy run and the WeSpeaker evaluation failed when the Docker daemon stopped
  (13:52), although the queue log prints `ACC-DONE`. Current status: `phase2c-stt-benchmark/README.md` (STATUS section).
- **Limitations listed under C1 that the completion pass changed:** `transcription_uncertainties` is now immutable and a
  direct speaker `DELETE` is refused (migration `0004_transcription_integrity`, not yet applied or integration-tested);
  the raw store is write-once with orphan adoption; diarization turns are validated against the recording duration. The
  remaining C1 limitations still stand.
- **Update (later on 2026-11-24, runtime validation).** Migration `0004` was applied to the dev database after a verified
  backup; the integration suites passed (DB 57, orchestrator 60, API 67); a genuine browser end-to-end run on the dev
  stack succeeded. Details: `PHASE2C_COMPLETION_REPORT.md`.
