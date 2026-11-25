# Phase 2C · completion audit (transcription and diarization foundation)

> **Current status (2026-11-26): Phase 2B and Phase 2C were formally accepted by the user on 2026-11-26.** See
> `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` §0. The text below is the historical record from before acceptance.

> **Superseded for current status (2026-11-25):** see `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` and `PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md` (real-provider validation, ADR-0036/0037/0041). This record is kept as history.

Audit date: 2026-11-24. Audit only: no application code, test, ADR or historical record was changed. Nothing was
committed. The only other change was a `graphify update .` refresh of `graphify-out/` (gitignored; the previous graph was
backed up automatically to `graphify-out/2026-11-24/`).

Repository state: branch `main`, HEAD `b407c38` (Phase 2A). **All Phase 2B and Phase 2C work is uncommitted** (255
changed or untracked paths). Phase 2B itself is **not accepted** (`PHASE2B_COMPLETION.md`: "awaiting the user's review
and explicit acceptance"), so Phase 2C sits on an unaccepted foundation.

Status key: **COMPLETE** · **PARTIALLY COMPLETE** · **NOT IMPLEMENTED** · **NOT VERIFIED** (exists, but this audit could
not confirm it works).

## 1. Verdict

**PARTIALLY COMPLETE: substantially implemented, but not finished.**

- **Implemented and verified at unit level:** the fake-provider foundation (workstreams C1 backend and C2 UI). The code
  exists end to end: contracts → migration → repository → orchestrator coordinator → API → recording-detail UI. Its unit
  suites pass with exactly the counts the development record claims.
- **Incomplete:** C3, the local STT/diarization benchmark that feeds the provider decision. Resource measurements ran on
  2026-11-23 but were **never folded into the report**. Two accuracy runs **failed silently** (§8.3). No provider is
  selected (OD-02b / OD-03b Open).
- **Not verified in this audit:** every integration and real-backend test. The Docker daemon is not running, so Postgres
  and Redis are unavailable. No test anywhere runs the assembled pipeline (browser → API → queue → orchestrator → DB) as
  one flow.
- **Not accepted:** `PHASE2C_DEVELOPMENT.md` says "in development … Not accepted". No Phase 2C completion record exists.

The fake adapters form a **complete control and data pipeline**: a run goes from submission to a persisted, versioned,
speaker-labelled transcript. It is **not an audio pipeline**. Neither fake reads any audio: the output depends only on
window times and duration (§3). Phase 2B outputs are used as metadata only.

## 2. Implementation inventory

| Layer | Files (all untracked or modified, uncommitted) |
| --- | --- |
| Contracts | `packages/contracts/src/transcription.ts` (341 lines), `jobs.ts` (`run-transcription`, `run-sweep`, `RunTranscriptionJob`, `JobIds.run`), `fixtures/transcription/` |
| DB | `packages/db/drizzle/0003_transcription.sql` (234 lines) + `meta/0003_snapshot.json`, `packages/db/src/transcription.ts` (879 lines), `schema.ts` |
| Orchestrator | `src/providers/{registry,errors,raw-store,clock}.ts`, `providers/stt/fake.ts`, `providers/diarization/fake.ts`, `src/runs/{run.step,run.workers,windowing,stitch,align,progress,queues,sweeper,types}.ts` |
| API | `src/runs/{runs.controller,runs.service,run.mapper,run-audit,runs.module}.ts`, `src/transcripts/*`, `src/queue/{run-queues.producer,run-settings}.ts` |
| Web | `src/components/transcription/{transcript-section,transcript-view,speakers-panel,use-run,use-transcript,model,api,fixtures}.ts(x)`, mounted in `pages/recording-detail.tsx`; Phase 2A `transcript-card.tsx` deleted |
| Benchmark (dev only) | `services/audio/benchmarks/{stt,diarization,resources}/`, `docs/development/phase2c-stt-benchmark/`, `[dependency-groups]` `stt-benchmark` / `diarization-benchmark` in `services/audio/pyproject.toml` |

## 3. Speech-to-text

| Capability | Status | Evidence |
| --- | --- | --- |
| Provider-neutral interface | COMPLETE | `SpeechToTextProvider` (`transcribe`, `mapRaw`, `capabilities().fake`) in `contracts/src/transcription.ts` |
| Fake adapter | COMPLETE | `providers/stt/fake.ts`: deterministic 10 s grid; text is literally `[fake transcript] window N (…)`; no confidence |
| Registration and selection | COMPLETE | `providers/registry.ts`: `STT_PROVIDER` key, only `fake` registered; an unknown key throws at worker startup (orchestrator int test "unknown provider key stops the run workers") |
| Job lifecycle | COMPLETE (unit) / NOT VERIFIED (integration) | `runs/run.step.ts` `executeRun`: `queued → running → completed/failed/cancelled`, guarded transitions |
| Use of Phase 2B processed audio | PARTIALLY COMPLETE | Uses `audio_preprocessings.normalizedUri`, `canonicalDurationMs` and `audio_segments` through `db/src/audio-processing.ts`. The fake **ignores `audioUri`**, so no audio bytes are read. No VAD is selected (OD-29), so in practice Phase 2B produces no segments and the VAD-window path runs only on test-inserted segments |
| Timestamped segments | COMPLETE | Absolute ms; overlap stitching by midpoint ownership (`runs/stitch.ts`); `validateSegments` rejects bad ranges and clamps to the duration |
| Language handling | PARTIALLY COMPLETE | Schema and DTOs carry `en`/`hi`/`mixed` and code-switch spans. The fake always returns `en`; `languageHints` are passed but unused. Hindi and Hinglish never go through the pipeline (only through UI fixtures) |
| Provider response validation | COMPLETE | zod `FakePayload` in `mapRaw` (`RAW_OUTPUT_INVALID`); coordinator range and confidence checks (`PROVIDER_OUTPUT_INVALID`); sha256 re-check on reuse (`RAW_OUTPUT_CORRUPT`) |
| Errors, retries, cancel, timeouts | COMPLETE (unit) / NOT VERIFIED (integration) | `ProviderError{retryable}`, BullMQ attempts and backoff, `withTimeout` (`PROVIDER_TIMEOUT`), deadline (`TIMEOUT`), cancel checked between windows, sweeper. Limitation: an in-flight provider call cannot be aborted; its result is discarded |

## 4. Diarization

| Capability | Status | Evidence |
| --- | --- | --- |
| Interface | COMPLETE | `DiarizationProvider` with the optional `window` (ADR-0016 hook) |
| Fake adapter | COMPLETE | `providers/diarization/fake.ts`: `SPEAKER_00`/`SPEAKER_01` alternate every 10 s, with a 0.5 s overlap at every third turn |
| Speaker identification and alignment | COMPLETE | `runs/align.ts`: longest-overlap assignment, ties to the smaller key |
| Unknown and overlapping speakers | PARTIALLY COMPLETE | `speaker_uncertain` when no turn overlaps a segment; `overlapping_speech` for cross-speaker overlap. `low_confidence`, `inaudible` and `language_uncertain` are never generated |
| Timestamp consistency | PARTIALLY COMPLETE | Turns are checked for `start ≥ 0`, `end > start` and a non-empty key, but **not bounded by the recording duration** (STT segments are) |
| Speaker persistence | COMPLETE | `speakers` table; immutable `speaker_key` (trigger), editable `display_name`; `PATCH …/speakers/{id}` is audited |
| Bounded memory (ADR-0016) | NOT IMPLEMENTED | Whole-file only; windowed mode and cross-window speaker matching are interface hooks |

## 5. Database and provenance

| Capability | Status | Evidence |
| --- | --- | --- |
| Run-scoped storage | COMPLETE | `transcripts.run_id` unique, composite `(id, workspace_id)` FKs to `pipeline_runs` (`0003_transcription.sql`) |
| Raw output preserved | COMPLETE | `stt_raw_outputs` / `diarization_raw_outputs` (sha256 CHECK, UPDATE-blocking triggers); payload written atomically (temp file + rename) by `LocalRawStore` |
| Versioning and v1 immutability | COMPLETE (schema) | `transcript_versions` (v1 must be `machine`, a correction needs a base), UPDATE triggers on versions and segments |
| Corrections, translation, transliteration kept separate | PARTIALLY COMPLETE | Corrections are modelled in the schema (`user_correction`) but have **no API**. `transcript_derivations` (translation/transliteration) is not implemented |
| Workspace isolation | COMPLETE (code) / NOT VERIFIED (run here) | Composite FKs on every table; every repository call is workspace-scoped; API int tests return 404 for another workspace's run (`apps/api/test/runs.int-spec.ts` L342, L559) |
| Traceability to recording and audio segments | PARTIALLY COMPLETE | Segment → `source_raw_output_ids uuid[]` (no FK possible) → raw row (window index and bounds) → run → `preprocessing_id` → recording. No FK to `audio_segments` (the designed `segment_id` was replaced by `window_index`) |
| Migration | COMPLETE (recorded) / NOT VERIFIED | Additive; backup `.local-backups/pre-0003-20261122T105819.dump` exists; the record says it was applied to the dev DB. Not re-checked (DB down). `0003` is not in the graph (no SQL parser installed) |

Data-integrity observations: `transcription_uncertainties` is mutable (acknowledged in the record). `transcript_segments.speaker_id` is `ON DELETE CASCADE`: deleting a speaker would delete rows of an immutable version. No code path deletes speakers today, so this is latent.

## 6. API and orchestration

| Capability | Status | Evidence |
| --- | --- | --- |
| Endpoints | COMPLETE for the scoped set | `POST /recordings/{id}/runs`, `GET /runs/{id}`, `POST …/cancel`, `POST …/retry`, `GET …/transcript{,/versions,/uncertainties,/raw}`, `GET …/speakers`, `PATCH …/speakers/{id}` (`runs.controller.ts`, `transcripts.controller.ts`) |
| Diarization flow | COMPLETE (integrated) | A stage in the same run, not a separate endpoint (D-2C-01, interim) |
| Background job | COMPLETE (unit) / NOT VERIFIED | One `run-transcription` job per run, concurrency 1. The designed per-window `stt-segment` jobs are not used |
| Status and progress | COMPLETE | `pipeline_stage_runs`, throttled progress (`runs/progress.ts`), `RunSnapshot` |
| Idempotency | COMPLETE (code) | Recording row lock + returning the active run (`runs.service.ts` `start`); `jobId = runId`; raw outputs are first-write-wins and reused on retry |
| Failure recovery | COMPLETE (code) | Sweeper re-enqueues or fails stuck runs; a user retry and a sweeper recovery share `RUN_MAX_RETRIES` (interim 3) |
| Contracts and validation | COMPLETE | zod `StartRunBody` (strict), `TranscriptQuery`, `SpeakerPatch` |
| Not implemented (documented) | — | `GET /runs/{id}/events`, correction versions, derivations, signed raw URLs, `hasLimitations`, cost |

## 7. Frontend

| Capability | Status | Evidence |
| --- | --- | --- |
| Transcript section on recording detail | COMPLETE | `TranscriptSection` mounted in `recording-detail.tsx` L83, gated on processing `completed` |
| Rendering, speakers, timestamps, rename | COMPLETE | `transcript-view.tsx`, `speakers-panel.tsx`; Devanagari and `lang` handled (unit tests) |
| Processing, error and empty states | COMPLETE | Per-state tests in `transcript-section.test.tsx`; a non-dismissible fake-provider banner |
| Integration with playback | PARTIALLY COMPLETE | Rendered next to `RecordingPlayback`, but clicking a timestamp does not seek the audio |
| Defect | — | `recording-detail.tsx` L94–97 still shows the Phase 2A placeholder "Transcription uncertainty … Not available yet" while the section above it shows uncertainty spans |
| Not verified | — | The sidebar `ProcessingStatusPanel` reads `r.latestRun` once from the recording fetch and may show a stale run status while a transcription run progresses |

## 8. Test results and evidence

### 8.1 Executed during this audit (2026-11-24)

| Suite | Result | Recorded claim |
| --- | --- | --- |
| `@vip/contracts` (Vitest) | 149 passed | 149 |
| `@vip/db` unit | 5 passed | 5 |
| `@vip/orchestrator` unit (Jest) | 71 passed (14 suites) | 71 |
| `@vip/api` unit (Jest) | 211 passed (17 suites) | 211 |
| `@vip/web` (Vitest) | 259 passed (17 files) | 259 |
| `pnpm typecheck` | pass (6 of 7 tasks cached by Turborepo for unchanged inputs) | pass |
| `pnpm lint` | pass | pass |

### 8.2 Recorded only (not re-run: Docker daemon down, so no Postgres or Redis)

DB integration 54 (20 transcription), API integration 67 (28 runs), orchestrator integration 58 (17 run cases in
`test/runs.int-spec.ts`: submit → completed with traceable raw outputs, VAD windows, cancel mid-run, retry reusing stored
windows, transient retry, exhausted attempts, deadline, provider timeout, sweeper recoveries). Playwright
`transcription.spec.ts`: 32 runs (3 test cases across projects and themes) against a **fully mocked network**. One dark-theme
axe failure was recorded and not reproduced.

### 8.3 Missing or incomplete

- **No assembled end-to-end test.** The orchestrator int test enqueues jobs itself. The API int test has no worker. The
  Playwright test mocks the API. Browser → API → BullMQ → orchestrator → DB → UI has never run as one flow. No manual
  dev-stack run is recorded either.
- No pipeline test with `hi` / `mixed` content, and no test of real audio reaching a provider. Neither is possible with
  the current fakes.
- **C3 benchmark is incomplete and inconsistent.** `.local-benchmarks/res-all2.log` shows resource runs completed on
  2026-11-23, but `results.json` still has `resources_main: null` and `feasibility_512m: null` for every engine.
  `run.py report` was never re-run. The Docker daemon died at 13:52; the whisper.cpp medium accuracy run and the
  WeSpeaker evaluation then failed, **yet the log prints `ACC-DONE`**. Unreviewed raw results: only whisper.cpp small
  (STT) and CAM++ (diarization) finished within 512 MB, and only on short clips (`long_minutes_in_512m_run: 0`). Every
  other STT engine was OOM-killed (exit 137). Every engine's RTF was ≥ 1 (slower than real time) on the host run.

## 9. Graphify

| | Before (graph of 2026-11-21 22:30) | After `graphify update .` (2026-11-24) |
| --- | --- | --- |
| Corpus files | 453 | 526 |
| Files with nodes | 368 | 432 |
| Nodes (code / concept / rationale) | 4,057 (3,544 / 259 / 254) | 4,723 (4,137 / 309 / 277) |
| Edges | 11,623 | 13,738 |
| Communities | 151 | 164 |
| Phase 2C source files represented | 0 new (only the pre-existing `runs.*` files and the deleted `transcript-card.tsx`) | 52 |

The previous graph **predated Phase 2C**, so `PROJECT_STATUS.md`'s line "Graphify graph current with the working tree"
was false. The "Built from commit" stamp still reads `b407c380` because the work is uncommitted; the scan itself
covers the working tree. Gaps: the four `.sql` migrations add nothing (`tree_sitter_sql` is not installed), and 10 spec
files yield no symbols. Community names are stale (`graphify label` would need an LLM backend, which the project
forbids).

What the graph shows (each finding checked against the source):

- **The provider seam is clean.** `graphify affected SpeechToTextProvider` and `DiarizationProvider` each reach only the
  registry, `RunDeps`, the fake, the module, the workers, `run.step`, the sweeper and the tests. No API or web code
  depends on the adapters, so a real adapter would touch only the orchestrator.
- **The API and the orchestrator are decoupled.** `graphify path RunsService executeRun` connects only through
  `@vip/db` (`getRun`), and `RunTranscriptionJob` is imported by both queue classes (`api/queue/run-queues.producer.ts`,
  `orchestrator/runs/queues.ts`). This matches ADR-0002: NestJS owns BullMQ, and the job payload carries IDs only.
- **Phase 2C does not call the audio service.** No edge or import connects `orchestrator/src/runs` or `providers` to
  the audio client or to `services/audio/src`. Phase 2B is reused only through `db/src/audio-processing.ts`
  (`getPreprocessing`, `listSegments`) and `contracts/src/processing.ts` (`storageUriForKey`). This is the structural
  evidence for "no audio reaches a provider".
- **`executeRun` is the hub** (degree 25). One function owns windowing, both stages, alignment and persistence; LangGraph
  is meant to replace it later (D-2C-01).
- **Web reuses Phase 2B UI.** `transcript-section.tsx` imports `processing/processing-card.tsx` (`Pill`, `ProgressBar`),
  and `transcription/model.ts` imports `processing/model.ts`.
- **No import cycles** among non-test files (SCC check on `imports` edges). No disconnected Phase 2C module: every
  source file reaches contracts or db.
- One spurious inferred edge (`transcripts.controller.ts` → `web/.../use-hero-3d.test.ts`) is extraction noise.
- No LangGraph, agent or paid-provider node exists anywhere in the graph or the source.

## 10. Architecture observations

- Conforms to ADR-0002, ADR-0007 (raw-first, immutable versions), ADR-0012 (fakes first), ADR-0015 (run-scoped),
  ADR-0019 (uncertainty separate from audio diagnostics) and ADR-0025 (`created → queued` on submission).
- Interim deviations are recorded as D-2C-01..03 and **not promoted**: no D-2C appears in HLD §10 or the ADRs, and
  OD-02b, OD-03b, OD-10 and OD-29 remain Open. Correct per the project rules.
- Latent risk before any real adapter: `LocalRawStore.put` overwrites the file before the DB row exists. If a stalled
  job were redelivered while the original was still running, a nondeterministic provider could leave file bytes that
  differ from the stored `sha256`. The run fails `RAW_OUTPUT_CONFLICT`, but the file is already replaced. This cannot
  happen with the deterministic fakes. Assessed as plausible, not reproduced.

## 11. Outstanding defects and decisions

**Defects (targeted corrections recommended, none applied):**

1. UI: remove or replace the stale "Transcription uncertainty … Not available yet" placeholder (`recording-detail.tsx`
   L94–97).
2. Diarization turns are not bounded by `durationMs` (`run.step.ts` `diarize`).
3. Benchmark: fold the 2026-11-23 resource results into `results.json` and the README; re-run whisper.cpp medium accuracy
   and the WeSpeaker evaluation; make the queue script stop printing `DONE` on failure.
4. Latent: `transcript_segments.speaker_id ON DELETE CASCADE`; `transcription_uncertainties` mutable; raw-store
   overwrite before the DB row (§10). These need a data-integrity review before a real provider is added.

**Documentation inconsistencies (not edited, because they are historical records):**

- `PHASE2C_DEVELOPMENT.md` says both "Applied only to the disposable `_test` database; the development database was not
  touched" (C1 results) and "applied to the dev DB after backup" (workstream table). The backup file supports the latter.
- The same file says the placeholder `TranscriptCard` was "now unused, left in place" (C2) and "was removed" (table).
  `git status` shows it deleted.
- `phase2c-stt-benchmark/README.md`: the header says "measured, awaiting the user's decision"; its STATUS section says
  partial.
- `API_SPECIFICATION.md` L3 header still lists only `GET /runs/{runId}` as partially implemented, which contradicts the
  per-section statuses in §3 and §5.
- `PROJECT_STATUS.md` claimed the graph was current. It is now true after this refresh.
- `apps/orchestrator/package.json` description mentions Phase 2B only.

**Decisions pending (the user's):** acceptance of Phase 2B (prerequisite) and of Phase 2C; D-2C-01..03; OD-02b STT
provider and OD-03b diarization (blocked on C3); OD-10 interim limits (30 s / 1 s windows, 3 retries, 1 h deadline,
120 s provider bound); OD-29 VAD; the PyAV GPL flag if faster-whisper is chosen; a real-speech dataset (OD-18).

**Known limitations (documented, accepted as scope):** one job per run; in-flight calls are not abortable; segment-level
stitching only; whole-file diarization; no correction or derivation API; no events stream; no cost tracking; the
`AppConfig` follow-up for run settings.

## 12. ADR-0034 compliance

**Compliant.** No new runtime dependency in any `apps/*` or `packages/*` manifest (only the workspace link `@vip/db` in the
orchestrator). No Anthropic, OpenAI or other paid SDK, and no LangGraph or LangChain, in `apps`, `packages` or
`services/audio/src` (grep). The only registered providers are `fake`, and the output is marked `fake: true` from adapter
to UI banner. The benchmark libraries (faster-whisper, pywhispercpp, sherpa-onnx; MIT and Apache-2.0) are confined to
`[dependency-groups]` that a default install leaves out, and the benchmark asserts they are absent from the runtime
image. They are free, offline and dev only. Flag: PyAV (via faster-whisper) bundles GPL codecs.

## 13. Recommended next action

Do not start Phase 3. In order:

1. Start Docker, then `pnpm infra:up`, then `pnpm test:integration` to re-verify the recorded 54 / 67 / 58 integration
   results (§8.2).
2. One manual or scripted end-to-end run on the dev stack: upload → preprocess → start transcription → transcript and
   speakers shown, with an isolated database as for Phase 2B.
3. Apply the small corrections in §11 (items 1–3) after the user approves them, and reconcile the listed doc
   inconsistencies.
4. Finish C3 (fold in the results, re-run the two failed jobs). Then the user decides OD-02b / OD-03b, considering that
   only whisper.cpp small and CAM++ fit 512 MB on short clips.
5. The user accepts Phase 2B, then Phase 2C (with or without a real provider), and a completion record is written.
