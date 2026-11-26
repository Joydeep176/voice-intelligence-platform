# Phase 3A: A1 design (architecture, low-level design, data flow, contracts, database, security and resources)

- **Status: ACCEPTED (ADR-0043–0047, user decision 2026-11-26), IMPLEMENTED (M0–M8), and Phase 3A formally accepted
  (2026-11-26).** Thresholds are approved (OD-52, ADR-0048: `a1-rules-1.0`, hybrid SNR estimator), and the lifecycle
  deviations are accepted (§9 notes 4, 10, 11; ADR-0044 Amendment 2).
- Where the implementation differs from the design below, see §9.
- Covers deliverables 3–7 and 10.
- Every element is tagged:
  - **[REUSE]**: exists and is used as is;
  - **[NEW]**;
  - **[MODIFY]**: existing code changes, with no behaviour change to accepted 2B/2C paths unless stated;
  - **[FUTURE]**: optional, not in Phase 3A.
- This design follows the recommended options for D-3A-00…13 (`PHASE3A_PLANNING_REPORT.md` §14). If the user picks
  other options, the affected sections are marked.

## 1. Phase 3A architecture (A1 in the existing platform)

```
 Browser (apps/web)                                       [MODIFY] Audio-quality card, processing step, diagnostics track
   │  REST (workspace-scoped, 404 isolation)
   ▼
 apps/api                                                 [NEW] GET …/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics
   │  enqueue (IDs only)                                  [MODIFY] processing snapshot gains measurementSet status
   ▼
 apps/orchestrator  (Node/NestJS, owns BullMQ)
   ├─ processing/  audio-probe → audio-preprocess         [REUSE] unchanged
   │                 └─ on succeeded → audio-measure      [NEW] step job (same pattern as preprocess.step.ts)
   ├─ agents/audio-quality/                               [NEW] A1 node: pure rule engine + repository (diagnostics only)
   │     triggered when measurement set is terminal and the run exists (D-3A-03)
   ├─ runs/ run-transcription (A2 stage scope)            [REUSE] unchanged in 3A; never waits for A1 (ADR-0046: may read read-only)
   └─ sweepers                                            [MODIFY] audio-sweep also recovers stuck measure steps
   │  HTTP task API (bearer token, 127.0.0.1)
   ▼
 services/audio (Python, sandboxed, 768 MB, 2 CPUs, 1 task at a time)
   ├─ probe, preprocess                                   [REUSE] unchanged (VAD stays `none`, hashes unchanged)
   ├─ transcribe, diarize                                 [REUSE] unchanged
   └─ measure                                             [NEW] speech-aware objective measurements; Silero VAD
                                                                 (pinned model, ADR-0038) in the sandboxed child; no judgements
   ▼
 Object storage (local root)          Postgres (Drizzle)
   level-series.json [REUSE]            audio_measurements [REUSE]
   speech-series.json [NEW]            audio_measurement_sets [NEW]   audio_diagnostics [NEW]   audio_diagnostic_flags [NEW]
```

**Responsibility split.** This keeps ADR-0019 intact and keeps the service's judgement-key guard
(`test_preprocess_unit.py` `FORBIDDEN_KEY`) valid.

- **The audio service measures.** Numbers only; it makes no judgement.
- **The orchestrator persists** the measurements, as the preprocessing coordinator already does.
- **A1 judges.** It is a node in the orchestrator and writes only diagnostics.

## 2. Low-level design

### 2.1 Audio service: `measure` task [NEW]

- **Contract:**
  - `TaskType` gains `"measure"`, mirrored in `packages/contracts` `AudioTaskType`.
  - `AUDIO_SERVICE_CONTRACT_VERSION` is bumped. **[MODIFY]**, contract only.
- **Input:** `{ canonicalKey, outputPrefix }` (keys only, as today).
- **Config:** hashed, so the step can be reused (ADR-0015 pattern).
  - `vad`: `{ method: "silero", threshold, minSilenceMs, minSpeechMs, paddingMs }`. **Default: the ADR-0038 values**,
    so A1's speech split matches what transcription uses (D-3A-07).
  - `blockMs`: the Tier 1 series resolution. Candidates 500 or 1000 ms, settled by M0.
  - `spectral`: `{ frameMs, rolloffFraction }` for the bandwidth estimate.
  - `digitalZeroMinRunMs`.
- **Processing:** streamed and bounded.
  - The canonical WAV (16 kHz mono s16) is read block-wise. The file is already verified; it is passed as an inherited
    descriptor, exactly like `transcribe`.
  - Silero VAD runs in the existing sandboxed inference child (`inference_child.py`). That reuses Landlock, rlimits,
    the fixed environment and model verification.
  - Per 10 ms frame: speech/non-speech, energy, and a digital-zero indicator.
  - Per block: speech ms, active-speech RMS, non-speech RMS, peak, and the spectral roll-off (speech frames only; a
    NumPy rFFT over short frames; no librosa needed).
  - Whole recording:
    - `speechRatio`, `activeSpeechLevelDbfs`, `nonSpeechLevelDbfs`, `snrProxyDb`;
    - `speechSpanCount` and the distributions of span and gap lengths (p50 / p90 / max);
    - `maxSpansPer30sWindow`, on the transcription window grid (D-3A-07);
    - `effectiveBandwidthHz` (speech frames);
    - `levelSpreadDb` (inter-block spread of the active-speech level);
    - `digitalZeroRuns`.
  - Every value is a `Quantity` with a kind and a method. Values that cannot be computed go to `unavailable` with a
    reason, for example `no_speech` or `too_short`.
- **Output:**
  - `MeasurementRecord` (schema version 2, `source: "canonical"`);
  - `artifacts.speechSeriesKey` (`speech-series.json`: a compact array per block, the same style as
    `level-series.json`);
  - `toolVersions` (service, NumPy, sherpa-onnx, the Silero model SHA).
- **Contract guard:** no keys matching `FORBIDDEN_KEY`. The existing guard pattern is extended to this result.
- **Deadline:** the media formula (120 s + 0.5 × duration), not the inference formula. The cost estimate is in §6.
- **Idempotency and reuse:** the output prefix is
  `<recording>/preprocessing/<preprocessingHash>/measure/<measureConfigHash>/`, and a verified published result is
  returned as is (same as preprocess).

### 2.2 Orchestrator: measurement step [NEW]

- **Queue:** `audio-measure`, payload `{ workspaceId, measurementSetId }`, with jobId = measurementSetId. It is a step
  job (`moveToDelayed` + `DelayedError`, a 2 s poll) that copies `preprocess.step.ts`.
- **Trigger:** when a preprocessing row becomes `succeeded`, or on demand from the API for older preprocessings that
  have no measurement set (backfill).
- **Writes:**
  - one `audio_measurement_sets` row (status, attempt, error, configHash);
  - on success, one `audio_measurements` row (schema version 2, `measurement_set_id` set) and the series key.
  - The writer is the preprocessing coordinator, as today (DATABASE_DESIGN "Writers").
- **Sweeper:** `audio-sweep` re-enqueues stuck sets, or fails them `TIMEOUT` (retryable), the same as preprocess rows.
  **[MODIFY]**

### 2.3 Orchestrator: A1 node `agents/audio-quality/` [NEW]

LLD §2 already reserves this module name.

- `rules/`: one pure function per rule. Input: `A1Input` (typed and validated); output: flags and partial
  suitability. The order is fixed.
- `engine.ts`:
  1. load the input;
  2. run the rules;
  3. merge regions;
  4. compute coverage;
  5. derive the overall class, confidence, suitability, recommendations and the not-assessed list;
  6. validate the output with zod.
- `config.ts`: the versioned rule configuration (`ruleVersion`, thresholds as integers, centi-dB etc.). It is
  validated at startup and never hard-coded in the rules. The config is snapshotted into
  `audio_diagnostics.rule_config`, A1's own table. It is **not** written to `pipeline_runs.config`: that is not A1's
  table (AGENT §2.2), and `submitRun` overwrites it when a `created` run is submitted
  (`packages/db/src/transcription.ts:146-157`).
- `repository.ts`: write methods **only** for `audio_diagnostics` / `audio_diagnostic_flags`, and reads only of
  measurement data. This is enforced by type, plus a test that the module imports no transcription table (TESTING §3,
  AGENT §2.2).
- **Trigger:** a `run-audio-quality` queue job keyed `aq-<runId>`. When it is enqueued is defined in the lifecycle
  below.
- **Isolation from the transcription job:**
  - A1 runs as a separate job, so it can fail, retry and complete on its own.
  - A1 never touches the `run-transcription` job. Its cost is milliseconds over stored measurements (§6).
  - The worker reads level and quality series from local storage with the same storage-root access that `raw-store`
    uses. **[REUSE]**
- **Stage record:**
  - A1 gets a `pipeline_stage_runs` row with node `audio_quality` (observability, retries). **[MODIFY]:** only the
    stage-*node* enum and its CHECK gain `audio_quality`.
  - **The transcription run scope stays separate.** `RUN_STAGES` is also the `run-transcription` scope
    (`stages: [...RUN_STAGES]` in `apps/api/src/runs/runs.service.ts:102`; the fallback in `run.mapper.ts:24`).
    Adding A1 to it would put A1 into every transcription job and silently settle D-3A-06. M1 therefore introduces a
    separate `STAGE_NODES` enum (`transcription`, `diarization`, `audio_quality`) for the stage table and leaves
    `RUN_STAGES` (the scope) unchanged.
  - `finishCancelled` currently hard-codes `['transcription','diarization']`. It must close only the stages that are
    still *open* (see L5 below).
  - Run completion semantics are D-3A-06.

#### 2.3.1 A1 stage lifecycle (canonical; D-3A-03 / D-3A-06; ADR-0044, Accepted)

This is the single definition. Every other document refers here.

| # | Event | Behaviour |
| --- | --- | --- |
| L1 | **Candidate preprocessing version** (pinning) | The run's `preprocessing_id` if set. Otherwise (a `created` run) the recording's latest `succeeded` preprocessing, the same rule `start()` uses (`runs.service.ts:75`). A1 records the version it assessed in `audio_diagnostics.preprocessing_id` |
| L2 | **Trigger** | *Accepted as built (ADR-0044 Amendment 2; §9 notes 1 and 4):* the trigger sweep enqueues `aq-<runId>-<attempt>` (idempotent jobId) when the run's status is `created`, `queued` or `running` and its candidate version has succeeded preprocessing; the A1 job itself ensures the measurement set first (a failed set gives Tier 0 only). *Original design:* enqueue once the measurement set is terminal. A1 runs on a `created` run before transcription is submitted. **[change to ADR-0025's consequences, accepted 2026-11-26]** |
| L3 | **Submission** (`created` → `queued`) | *Amended (ADR-0044 Amendment 2):* the sweep re-assesses whatever the latest A1 stage status is, except while one is running, under the attempt cap. If no completed diagnostics exist for the run's now-fixed `preprocessing_id`, A1 is (re-)enqueued as a new stage attempt. Transcription is never delayed. Consumers (UI, `AudioQualityReader`, later A6) use only diagnostics whose `preprocessing_id` equals the run's |
| L4 | **Failure** | The `audio_quality` stage is `failed` with a code. Run status and transcription are unaffected (D-3A-06 a; ADR-0021: an A1 failure blocks only A6) |
| L5 | **Cancellation of the run** | This applies to a `created` run and to `queued` / `running` runs (existing). ADR-0025 already allows cancelling a `created` run, but `RunsService.cancel` returns 409 for it today (`runs.service.ts:135`); Phase 3A closes that gap. Cancellation stops a pending or running A1 stage, as ADR-0014 and AGENT §2.1 ("cancellation stops both branches") require. Completed diagnostics and a completed A1 stage are kept and not rewritten (ADR-0014 keeps completed artefacts). `finishCancelled` closes only open stages |
| L6 | **A1-only retry** | `POST …/runs/{runId}/audio-diagnostics/retry` (§2.4; accepted). *Amended (ADR-0044 Amendment 2):* it is allowed when there is no A1 stage, the latest one is `failed` / `cancelled`, or the completed one is for another version. As first written, it was allowed when the latest A1 stage for the pinned version is `failed`, and the run is not `cancelling` / `cancelled`. It creates a new stage attempt and new diagnostics, bounded by a configured A1 attempt cap (ADR-0010, ADR-0014). It is not a run retry: `retry_count` is unchanged, so ADR-0025's "a `created` run is not retried" still holds for the run. **[accepted 2026-11-26]** |
| L7 | **Run-level retry** (existing, for `failed` / `cancelled` runs) | It also re-runs A1 if no completed A1 stage exists for the pinned version |
| L8 | **Measure task** | It is preprocessing-scoped and shared by runs, so run cancellation does **not** cancel it. Proposed: `POST /recordings/{id}/processing/cancel` also cancels an active measurement set (through `DELETE /v1/tasks/{id}`) |
| L9 | **UI wording** | A `created` run with diagnostics reads "Audio assessed; transcription has not been started", amending ADR-0025's "has not been processed" wording. **[accepted 2026-11-26]** |
| L10 | **Deletion** | Cascades with the recording (§5, SEC-6) |
- **Queues:**
  - `run-audio-quality` (implemented), with configured concurrency (1), attempts, backoff, timeout and stalled
    settings (ADR-0010).
  - A separate `audio-measure` queue was designed but **not built**: the measure step runs inside the A1 job (§9
    note 1, ADR-0045 amendment).
  - They are added to the validated config, the same as the existing queues. Values are set in M2 / M5 and reviewed.

### 2.4 API [NEW / MODIFY]

All paths are relative to the API base `/api/v1/workspaces/{workspaceId}` (API §1), so every route is workspace-scoped
and returns 404 across workspaces.

- **`GET /runs/{runId}/audio-diagnostics`** [NEW] (designed in API §4); the full path is `GET /api/v1/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics`. It returns `AudioDiagnostics`
  (§4): the summary, the flags, the not-assessed list, and `measurements` (the objective records it was based on). It
  returns 404 across workspaces through `WorkspaceAccessGuard`. Flags are paged by time range (`fromMs`, `toMs`) for
  long recordings, the same principle as the transcript.
- **`GET /recordings/{id}/processing`** [MODIFY, additive]: gains `measurementSet: { status, error, configHash }`.
- **`POST /runs/{runId}/audio-diagnostics/retry`** [NEW, accepted, implemented]: an A1-only retry under the rules of
  lifecycle L6.
- **`POST /recordings/{id}/processing/measure`** [NEW, accepted, NOT implemented]: an idempotent backfill trigger. It creates the
  measurement set for an existing succeeded preprocessing that has none, for recordings preprocessed before Phase 3A.
  The alternative is an orchestrator start-up sweep with no endpoint; the choice is made in M5.

### 2.5 Web [MODIFY]

- `recording-detail.tsx` "Audio quality" card: becomes live.
- `processing-status.tsx` "Audio quality analysis" step: gains a state.
- `timeline/timeline-placeholder.tsx` `diagnostics` track: draws flag regions. It must not use a new library while
  OD-35 is Open; a dependency-free SVG or canvas is acceptable.
- `use-audio-diagnostics.ts`: polls like `use-run.ts`.
- Existing UI type `AudioDiagnosticFlag` (`timeline/types.ts`): replaced by the contract type.

## 3. Data flow and workflow

```
upload ─► probe ─► preprocess (VAD none, Tier 0 measurements, level-series)         [existing, unchanged]
                      │ succeeded
                      ▼
                 measure task (Tier 1, Silero speech split, speech-series)           [new, deterministic]
                      │ terminal (succeeded | failed)
                      ▼
 run (status created at upload, ADR-0025) ──► A1 classify ──► audio_diagnostics + flags   [new, run-scoped]
      │                                           │
      │ user clicks "Start transcription"         └─► UI: card / step / timeline
      ▼
 run-transcription (A2): windows → STT → diarize → transcript v1                      [existing, unchanged]
      │
      ▼
 (future) A3 → A4 → A5 ─┐
 A1 summary ────────────┴─► A6 Reporting (join) ─► A7 QA
```

- **Measurement sharing:**
  - Measurements belong to the preprocessing version and are shared by all runs on it.
  - Diagnostics belong to a run and its rule version, so a rule-version change on a re-run gives new diagnostics and
    never mutates old ones.
- **Ordering:**
  - The measure task is queued on the audio service like any task (one at a time).
  - If transcription is started immediately, the audio service may run `measure` before or between transcribe
    windows. A transcribe window waits at most the measure duration (§6); measure is never interleaved within a window.
  - Whether `measure` should be deprioritised behind transcription is an M4 detail. The default is FIFO, which is the
    existing behaviour.

## 4. Data contracts (proposal, `packages/contracts`)

```ts
// Shared enums
export const AUDIO_QUALITY_CLASSES = ['good', 'acceptable_with_warnings', 'poor', 'insufficient'] as const; // D-3A-04
export const SUITABILITY = ['suitable', 'limited', 'unreliable', 'not_assessable'] as const;
export const DIAGNOSTIC_FLAG_KINDS = [
  'noise', 'clipping', 'distortion', 'dropout', 'silence', 'low_level',            // designed (DATABASE_DESIGN)
  'low_speech_presence', 'narrowband', 'level_inconsistency', 'fragmented_speech', // proposed additions, D-3A-07
] as const;
export const FLAG_SEVERITIES = ['low', 'medium', 'high'] as const;
export const EVIDENCE_BASIS = ['measured', 'derived', 'estimate'] as const;

// The A1 shapes other components may read (A2, A3, A6, A7, UI) — ADR-0046 (Accepted). No routing in 3A.
export const AudioQualitySummary = z.object({
  schemaVersion: z.literal(1),
  diagnosticsId: z.uuid(), runId: z.uuid(), preprocessingId: z.uuid(),
  ruleVersion: z.string(),
  overall: z.enum(AUDIO_QUALITY_CLASSES),
  confidence: z.enum(['high', 'medium', 'low']),
  suitability: z.object({
    transcription: z.object({ value: z.enum(SUITABILITY), reasons: z.array(z.string()) }),
    diarization:   z.object({ value: z.enum(SUITABILITY), reasons: z.array(z.string()) }),
  }),
  flagCounts: z.record(z.enum(DIAGNOSTIC_FLAG_KINDS), z.record(z.enum(FLAG_SEVERITIES), z.number().int())),
  affectedSpeechRatio: z.number().min(0).max(1).nullable(),
  notAssessed: z.array(z.object({ dimension: z.string(), reason: z.string() })),
  tiers: z.object({ tier0: z.literal(true), tier1: z.enum(['available', 'failed', 'pending']) }),
}).strict();

export const AudioDiagnosticFlag = z.object({
  id: z.uuid(), kind: z.enum(DIAGNOSTIC_FLAG_KINDS), severity: z.enum(FLAG_SEVERITIES),
  startMs: z.number().int().nullable(), endMs: z.number().int().nullable(), // null/null = whole recording
  basis: z.enum(EVIDENCE_BASIS), ruleId: z.string(),
  measurementRefs: z.array(z.object({ quantity: z.string(), series: z.enum(['level', 'speech']).optional(),
                                      fromIndex: z.number().int().optional(), toIndex: z.number().int().optional() })),
}).strict();

export const AudioDiagnostics = z.object({
  summary: AudioQualitySummary,
  recommendations: z.array(z.object({ code: z.string() })), // rendered from versioned templates in the UI
  flags: z.array(AudioDiagnosticFlag),
  measurements: z.array(AudioMeasurementRecord),             // existing schema, objective values it was based on
}).strict();
```

- **The `measure` task contract** mirrors the existing `preprocess` contract style: request, config (hashed), result
  with `MeasurementRecord` schema v2 and a series key, and fixtures under `packages/contracts/fixtures/audio-service/`,
  including a judgement-key `.invalid.json`.
- **Read view and port** (ADR-0046, Accepted):

```ts
export const AudioQualityContext = z.object({
  summary: AudioQualitySummary,
  flags: z.array(z.object({ kind: z.enum(DIAGNOSTIC_FLAG_KINDS), severity: z.enum(FLAG_SEVERITIES),
                            startMs: z.number().int().nullable(), endMs: z.number().int().nullable() })),
}).strict();
export type AudioQualityLookup =
  | { status: 'available'; context: AudioQualityContext }
  | { status: 'unavailable' | 'pending' | 'failed' };
export interface AudioQualityReader {                     // read-only; implemented over A1's tables
  get(q: { workspaceId: string; runId: string; preprocessingId: string }): Promise<AudioQualityLookup>;
}
```

- **Node boundary** (framework-independent, D-3A-02): `A1NodeInput` `{ workspaceId, runId, preprocessingId,
  measurementSetId | null, ruleConfig }` and `A1NodeOutput` `{ diagnosticsId, stateSlice }`. The BullMQ job in 3A and a
  LangGraph node later are both adapters over the same function.
- **Pipeline state** (the shared graph): `audioQuality?: { diagnosticsId; overall; confidence }`. This
  supersedes AGENT §3's illustrative `{ overall: 'good'|'degraded'|'poor'; flagCount }` if D-3A-04 is approved.
- **Recommendation text** lives in the web app (i18n-ready, English first). The contract carries codes only, which
  keeps report language independent (ADR-0006).

## 5. Database changes (proposal; one Drizzle migration, `0005_audio_quality`)

| Table | Status | Columns and constraints |
| --- | --- | --- |
| `audio_measurement_sets` | NEW | `id`, `workspace_id`, `preprocessing_id`, `config_hash`, `config` (jsonb, canonical record), `status` (`queued\|running\|succeeded\|failed\|cancelled`), `attempt`, `error {code, retryable}`, `task_id`, `series_uri`, `tool_versions` jsonb, timestamps. Composite FK (`preprocessing_id`, `workspace_id`) → `audio_preprocessings` CASCADE; unique (`preprocessing_id`, `config_hash`) |
| `audio_measurements` | MODIFY | Add a nullable `measurement_set_id`, with a **composite** FK (`measurement_set_id`, `preprocessing_id`) → `audio_measurement_sets(id, preprocessing_id)` CASCADE (the segment-FK pattern). Keep `audio_measurements_whole_uq` and narrow its predicate to `segment_id IS NULL AND measurement_set_id IS NULL` (Tier 0 unchanged; a plain index with a nullable column would not be unique, because Postgres treats NULLs as distinct). Add a partial unique (`measurement_set_id`, `source`) WHERE `measurement_set_id IS NOT NULL`. The segment unique and the immutability trigger are unchanged. **Existing reader:** `getMeasurements(…, {segmentId: null})` (`packages/db/src/audio-processing.ts:343-361`, used by the processing snapshot) must filter `measurement_set_id IS NULL`, or Tier 1 rows would leak into the accepted `ProcessingSnapshot`. That needs a regression test (AC-3) |
| `audio_diagnostics` | NEW (designed) | As DATABASE_DESIGN, plus: `confidence`, `suitability` jsonb, `not_assessed` jsonb, `measurement_set_id` (nullable: Tier 0 only), `rule_config` jsonb (snapshot), `attempt`, `created_at`. `overall` CHECK uses the D-3A-04 classes. Composite FKs to `pipeline_runs(id, workspace_id)` and `audio_preprocessings(id, workspace_id)`; unique (`run_id`, `rule_version`, `attempt`). **Immutable after insert** (the trigger pattern of `audio_measurements`): re-assessment inserts a new row |
| `audio_diagnostic_flags` | NEW (designed) | As DATABASE_DESIGN, plus `workspace_id`, `diagnostics_id` (composite FK (`diagnostics_id`, `workspace_id`) → `audio_diagnostics(id, workspace_id)` CASCADE), `basis`, `rule_id`. Index (`diagnostics_id`, `start_ms`). Immutable |
| `pipeline_stage_runs` | MODIFY | The `node` CHECK gains `audio_quality` |

- **Deletion:** these tables cascade from `recordings` through `audio_preprocessings` / `pipeline_runs`. Series
  objects live under the recording's storage prefix, so SEC-6 deletion covers them. The existing deletion test is
  extended.
- **No transcription table** gains a reference to diagnostics, and the reverse is also true (FR-3.3).
- **Corrected-transcript runs** (ADR-0020, OD-26b *Proposed*) would reference the parent run's diagnostics; that
  mechanism stays with OD-26b.

## 6. Resource and performance estimates

**Tier 0 classification:**
- It reads the stored records and the 100 ms level series: 4 h = 144,000 windows, about 1.5 MB of JSON.
- It runs in the Node worker, O(n), well under 1 s, with a few MB of memory.
- It makes no audio-service call.

**Tier 1 `measure` task** (estimates, not measurements; M0 gives indicative harness figures, and M4 measures the implemented task, which is the only acceptance evidence):

| Item | Evidence | Estimate |
| --- | --- | --- |
| Silero VAD | Phase 2B VAD benchmark: RTF 0.017 at 1 CPU, `memory.peak` 172 MiB | About 4 min for 4 h at 1 thread; less at 2 |
| Block features (energy, rFFT roll-off on speech frames) | NumPy, streamed; comparable to the preprocess analysers | A small fraction of the VAD cost |
| Read of the canonical WAV | 4 h = about 460 MB, streamed from local SSD | Seconds |
| Memory | Bounded streaming; the frame arrays of `FrameStatsBuilder` are about 17 MB for 4 h | Well under 768 MB, alongside the parent service. To be proven on a generated 4 h file (NFR-7) |
| Deadline | Media formula: 4 h → 2 h 2 min | Ample margin |
| `speech-series.json` | 4 h at 1 s blocks ≈ 14,400 × about 10 values | About 1–1.5 MB |

- **Effect on transcription:** the audio service runs one task at a time.
  - A 90 s clip adds a few seconds before or between windows.
  - A 4 h recording adds a few minutes, against a transcription that takes hours for 4 h.
- **No change** to CPU, memory or thread limits, deadline formulas, the model or the windows.

## 7. Security, privacy and resources

- **No new trust boundary.** It uses the same bearer-token task API, sandboxed child, Landlock, rlimits, FSIZE=0 in the
  child, no network, and a read-only, pinned and verified Silero model that is already mounted (ADR-0035, ADR-0039).
- **No new dependency or download.** NumPy and sherpa-onnx are already runtime dependencies. librosa stays unused.
- **Content safety:**
  - A1 never reads transcripts.
  - Measurements are numeric, but they are derived from the audio, so they are treated as recording data: workspace
    FKs, 404 isolation, deletion with the recording.
  - Logs carry IDs and codes only (SEC-9). A log-capture test is extended to the measure and A1 paths.
- **Input safety:** only the already-verified canonical WAV is read. The original media is not re-decoded (probe and
  preprocess have already validated it).
- **Integrity:**
  - Measurements and diagnostics are immutable (triggers).
  - The rule version and the config snapshot are stored with every diagnostics row (reproducibility).
- **Separation enforcement:** repository write surfaces, plus an import-graph test, plus contract tests (AC-2).
- **Fixtures:** synthetic or consented only (ADR-0004). Degradation fixtures are generated, not committed when large.
- **Review gates:** the `security-reviewer` agent reviews the migration, the API route and the measure task before the
  respective milestone is accepted.

## 8. Optional future enhancements [FUTURE]

- **Non-intrusive quality or intelligibility model:** for example DNSMOS-style ONNX models. Its licence must be
  verified. It would need an ONNX runtime path outside sherpa-onnx, which means a new dependency and an ADR.
- **Blind reverberation (C50 / DRR) estimation.**
- **Speech enhancement** (RNNoise, DeepFilterNet). It changes A2's input, so it needs the E7-style accuracy gate and an
  ADR.
- **Any quality-driven behaviour in A2 or A3:** each needs its own ADR, plus the accuracy gate for A2. No automatic
  skip or block is planned (ADR-0008).
- **Per-language calibration** once the OD-18 real-speech corpus is downloaded.
- **Server-side waveform peaks** (OD-39, deferred). Not to be confused with the quality series.

## 9. Implementation notes and deviations (2026-11-26)

1. **No separate `audio-measure` queue or step job.** The measurement coordinator (`processing/measure.ts`, on the
   preprocessing side) runs the `measure` task inside the A1 job, *before* the A1 node, through the existing
   `runAudioTask` helper (content-derived idempotency keys). Measurement sets stay preprocessing-scoped and are reused
   by every run. The A1 node itself only reads.
2. **The speech series is written by the orchestrator**, under `derived/<ws>/<rec>/a1-measure/<hash>/`, not by the
   audio service. The sandboxed child has FSIZE=0; the result comes back over the task API.
3. **Audio-service contract version unchanged ('2').** `measure` is an additive task type. An older service rejects it
   (`UNSUPPORTED_TASK_TYPE`), the set is recorded `failed`, and A1 degrades to Tier 0 with `low` confidence.
4. **A1 trigger:** a repeatable sweep (`AUDIO_QUALITY_SWEEP_INTERVAL_MS`, 15 s), not hooks in the accepted preprocess or
   submission paths. Latency from a completed preprocessing to an assessment is therefore up to one interval plus the
   measure time.
5. **Not implemented:**
   - L8's processing-cancel of an active measurement set;
   - the backfill endpoint `POST /recordings/{id}/processing/measure` (the A1-only retry ensures the set instead);
   - the `measurementSet` field on the processing snapshot.
6. **Measure config hash:** SHA-256 of key-sorted JSON. The shared `canonicalJson` is integer-only, and the VAD
   threshold is fractional.
7. **Spans per window** come from global spans clipped to the 30 s / 1 s grid, an approximation of transcription's
   per-window VAD. On the 2C clips it gives the same counts (2 and 14).
8. **Memory:** frame arrays are kept as float32 (about 7 MB for 4 h). The measured anonymous peak is 140 MiB for 4 h
   (M4).
9. **Implemented shapes that differ from §4 / §5:**
   - The summary uses `affectedRatio`, `tier1` (`available | failed | pending | not_requested`), `provisional` and
     `createdAt`, where §4 has `affectedSpeechRatio` / `tiers`.
   - `A1NodeInput` carries no `ruleConfig`: the worker supplies the rule config.
   - `AudioDiagnostics` adds `tier1Record` (the Tier 1 record the assessment rested on, FR-3.1).
   - `audio_diagnostics` is unique on (`run_id`, `attempt`) and has no `task_id`.
   - The jobId is `aq-<runId>-<attempt>`.
10. **The A1-only retry (L6) is wider than written:** it is allowed when there is no A1 stage, or the latest one is
    `failed` / `cancelled`, or the completed one is for another preprocessing version. This is how assessments of
    runs from before Phase 3A are requested.
11. **L3 / L7:** after submission or a run retry, the sweep re-assesses a queued or running run that has no
    diagnostics for its preprocessing version, whatever the latest A1 stage status, under the attempt cap.
12. **Bounded workers (security review):**
    - a lost A1 job fails its stage with `A1_STALLED` and is not re-enqueued;
    - measurement sets have an attempt cap in every status and a compare-and-set on the attempt counter;
    - stale running sets are failed with `MEASURE_STALLED` (retryable);
    - series files are size-capped and symlink-checked.
13. **Notes 1 and 3 were accepted by the user (2026-11-26)** and recorded as amendments to ADR-0045 and ADR-0044.
    **Notes 4, 10 and 11 were accepted by the user (2026-11-26, Phase 3A acceptance)** and recorded as ADR-0044
    Amendment 2. They amend L2, L6 and L3 / L7 in §2.3.1.
14. **Thresholds approved (OD-52, ADR-0048, 2026-11-26):**
    - rule version `a1-rules-1.0` (`provisional: false`);
    - the `measure` config gains `snrNearCleanDb` (45 dB): near-clean audio uses the median noise-frame power for
      the recording and every block, otherwise the mean.
