# Low-Level Design (LLD)

Status: **Design; Phase 1 foundation implemented** (`docs/development/PHASE1_FOUNDATION.md`): §1 layout plus `packages/config`; `apps/api` modules `health`, `recordings`, `runs` (status read), `storage` (local), `audit` (write), `queue` (foundation-check producer), and a development-only principal instead of `auth`; `apps/orchestrator` with the foundation-check worker only; `services/audio` with probes and the prototype handshake below. Agents, graph, providers and pipeline queues are not implemented. Tooling follows ADR-0005. Integration follows ADR-0002 (provisional until prototyped). Items tagged *Proposed* are not approved.

## 1. Repository layout (*Proposed*, pnpm + Turborepo + uv)

```
apps/
  web/              React + Vite + Tailwind + shadcn/ui
  api/              NestJS HTTP API
  orchestrator/     NestJS standalone app: BullMQ workers, LangGraph, agents, adapters
services/
  audio/            Python audio service (uv-managed), internal HTTP API
packages/
  contracts/        zod schemas: API DTOs, job payloads, report model, audio-service API types
  db/               Drizzle schema + migrations (shared by api and orchestrator)
infra/
  docker/           Compose, Dockerfiles
  aws/              IaC (tool: OD-17)
docs/
```

## 2. Modules

### 2.1 `apps/api`
| Module | Responsibility |
|---|---|
| `auth` | Principal resolution (IdP deferred, OD-08b); workspace membership guard on every route (SEC-2/3) |
| `recordings` | Upload sessions (multipart, resumable), consent attestation, shallow validation, listing, async deletion |
| `runs` | Start / cancel / retry; status snapshots; progress stream (ADR-0018) |
| `transcripts` | Versions, segments, speakers, display names, corrections, uncertainties, derivations (read) |
| `analysis` | Diagnostics, topics, entities, claims, sources, validations |
| `reports` | Report versions (HTML rendering data), QA results, exports |
| `audit` | Append-only audit writer + admin read |
| `storage` | `StorageService`: `LocalStorage` / `S3Storage` (S3 not implemented). Keys built from IDs only, validated and contained in the root. `statObject` and `openReadStream(key, range?)` serve playback (ADR-0033); an S3 version maps to ranged GetObject or presigned GETs |
| `queue` | BullMQ producers + `QueueEvents` subscriber for progress |

- **Playback** (`playback` module, ADR-0033): HMAC-SHA256 signed, short-lived (`MEDIA_URL_TTL_SECONDS`, default 300) tokens bind recording, workspace and expiry.
  - **Issuance:** under the workspace route, audited, fail closed.
  - **Media route** `/api/v1/media/recordings/{token}`: verifies the token in constant time, re-checks ownership and status, and streams through `StorageService` with HTTP Range. Every failure is a uniform 404.
  - **Logs:** tokens never appear, because request logs record route patterns only. A failed stream logs `playback_stream_failed` with the error code and recording id only (client disconnects are not logged).
- **Dev Host guard** (Phase 2A validation finding SEC-01): while `AUTH_MODE=dev`, `devHostGuard` is registered before every route (health and media included) and answers `403 HOST_NOT_ALLOWED` for any non-loopback `Host` hostname (port ignored). This mitigates DNS rebinding against the unauthenticated development API. Config validation also refuses a non-loopback `API_HOST` while `AUTH_MODE=dev`.
- **Upload concurrency** (Phase 2A validation finding SEC-04): a part body is first streamed to a unique staging key without any lock; a short transaction then takes the recording row lock (`SELECT ... FOR UPDATE`), re-checks the recording and session, and moves the staged part into place, so a part cannot land during completion or after the recording leaves `uploading`. Completion holds the row lock while it composes the original (local storage I/O; acceptable in development, to be revisited with S3). No second database connection is taken while the lock is held; an expired session is persisted after the transaction. Orphaned staging objects after a crash are not yet swept (see the deferred upload-cleanup finding).

### 2.2 `apps/orchestrator`
| Module | Responsibility |
|---|---|
| `graph` | LangGraph definition, state, Postgres checkpointer, pause/resume |
| `graph/nodes/preprocessing` | Deterministic preprocessing node (step 2, ADR-0019). Not an agent; no LLM |
| `agents/<agent>` | `audio-quality`, `transcription`, `context-intelligence`, `research`, `fact-validation`, `reporting`, `qa`: node, prompts, schemas |
| `providers/stt` | `SpeechToTextProvider`: `fake` (development, tests) and `whisper-cpp` (`WhisperCppSttProvider`, ADR-0036: an audio-service `transcribe` task per window) |
| `providers/diarization` | `DiarizationProvider`: `fake` and `sherpa-onnx` (`SherpaOnnxDiarizationProvider`, ADR-0037: one audio-service `diarize` task per recording) |
| `providers/research` | `ResearchProvider` (ADR-0017) + fake |
| `providers/llm` | Claude factory: per-agent model config, retries, budget check, `llm_calls` recording |
| `audio-client` | Typed client for the audio-service internal API |
| `workers` | BullMQ processors (see §5) |
| `exports` | PDF/DOCX rendering jobs (tooling OD-25) |
| `deletion` | Recording deletion job (DATABASE_DESIGN §6) |

### 2.3 `services/audio` (Python, deterministic service; no DB/Redis access; ADR-0002, ADR-0019)
| Module | Responsibility |
|---|---|
| `api` | Internal HTTP adapter. FastAPI + uvicorn (OD-23a, ADR-0023, prototype confirmed). The contract is defined independently of the framework (§3.1) |
| `tasks` | In-process bounded task executor: one running slot and a bounded queue (configurable), idempotency keys, overall task deadline (media: 120 s + 0.5 × duration; inference: 120 s + 4 × audio; OD-10, ADR-0039), cooperative cancellation, progress. Implemented Phase 2B |
| `probe` | Sandboxed ffprobe deep validation (step 1): magic-byte demuxer selection, allow-lists, limits, bounded trial decode; container tags never returned. Implemented Phase 2B |
| `preprocess` | Step 2: streamed FFmpeg decoding (native and canonical passes), canonical WAV, timeline mapping, objective measurements (computed here, ADR-0019), VAD-agnostic segmentation (preprocessing VAD stays `none`; Silero VAD is applied inside transcription windows, OD-29 / ADR-0038). Verifies the config hash and tool versions; idempotent reuse of a verified published version. Implemented Phase 2B |
| `measure` | Objective block-wise measurements (NumPy; librosa deferred) are computed inside `preprocess` and stored once per preprocessing version; there is no separate `measure` task. A1 reads them. No classification or judgement |
| `transcribe` | Silero VAD speech spans + whisper.cpp (Whisper small q5_1) per span on one canonical-audio window (ADR-0036, ADR-0038). Pinned models from `AUDIO_SERVICE_MODELS_DIR`, verified at startup; offered only when they verify |
| `diarize` | sherpa-onnx: pyannote segmentation-3.0 + CAM++ (ADR-0037); whole file up to 10 min, else windows with cross-window speaker matching (ADR-0016) |

## 3. Interfaces

### 3.1 Audio-service internal API (ADR-0002; contract v2 implemented in Phase 2B as the prototype; formal acceptance of the shape is pending the user's Phase 2B review)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/capabilities` | Measured tool versions (service, Python, FFmpeg, NumPy, VAD `none`), Landlock state (supported, ABI, enforced, scoped), task types |
| POST | `/v1/tasks` | Submit `{ contractVersion: "2", type: probe\|preprocess, idempotencyKey, workspaceId, recordingId, input: { originalKey, outputPrefix }, config }` → `202 { taskId }`. Same key + same body → same task; different body → `409 IDEMPOTENCY_CONFLICT`; queue full → `503 CAPACITY_EXCEEDED`. `diarize` is a later phase |
| GET | `/v1/tasks/{taskId}` | `{ status: queued\|running\|succeeded\|failed\|cancelled, progress: { fraction, processedMs, stage }, deadlineAt?, result?, error?: { code, retryable } }`; unknown → `404 TASK_NOT_FOUND` |
| DELETE | `/v1/tasks/{taskId}` | Cooperative cancellation |
| GET | `/health/live`, `/health/ready` | Liveness (unauthenticated); readiness `503` when storage, FFmpeg or required Landlock enforcement (media or inference profile) is missing, or the confined inference child cannot read the models |
| POST | `/v1/handshake` | **Implemented Phase 1 prototype.** `{ contractVersion, requestId }` → `{ contractVersion, serviceVersion, requestId, accepted }`; unknown version → `422 CONTRACT_VERSION_MISMATCH`. Used by the API health check to verify reachability and contract compatibility |

- Results are JSON metadata plus storage URIs (artefacts written to object storage by the service). Node persists the metadata to Postgres.
- Task state is in memory. If the service restarts, the task disappears (`404`); Node treats that as retryable and resubmits with the same idempotency key, within retry bounds.
- Inference tasks (`transcribe`, `diarize`) use an idempotency key derived from the task content (type, recording, input keys, config). A resubmit after a lost response, a queue retry or a second orchestrator therefore joins the task already queued or running instead of queueing a duplicate on the single slot. When the service answers that key with an earlier `failed` / `cancelled` task, the adapter resubmits under a numbered suffix, so a retry runs again and never replays a failure (`providers/audio-task.ts`, 2026-11-25).
- Networking and authentication (ADR-0035): development publishes the service to `127.0.0.1:8001` only on a normal
  bridge and requires a bearer token (`AUDIO_SERVICE_TOKEN`) on every route except liveness; container egress is
  possible in this topology. All-in-Compose: `internal: true` network only, no published port; production
  authentication mechanism OD-23c (Open). Bearer-token auth is implemented (Phase 2B).
- Error codes, untrusted-media controls and timeline semantics: `packages/contracts/src/audio-service.ts`,
  `docs/development/PHASE2B_PLAN_DRAFT.md` §6 and §11, `services/audio/VERIFICATION_*.md`. Python never parses media
  itself; FFmpeg children run with fd-only input, allow-lists, a clean environment, rlimits and Landlock.
- **Inference isolation** (ADR-0036 / ADR-0037). The native engines hold the GIL, so `transcribe` and `diarize` run in
  a child process started by the same `SandboxRunner` (`domain/isolation.py`) with an *inference profile*:
  - Landlock read/execute beneath the system paths plus the virtual environment and the models directory; no TCP;
    scoped signals and sockets.
  - The same rlimits (CPU scaled by threads, `FSIZE=0`, `NOFILE=64`, `CORE=0`).
  - A fixed environment (thread pins, never the token).
  - The canonical WAV as an inherited descriptor; the task message as argv; JSON-line output (capped).
  - Startup self-tests both confinement and that the child can read every pinned model. Landlock rules do not match
    on Docker Desktop host bind mounts, so Compose serves `/models` from a named volume.
- **Framework independence** (ADR-0002 constraint): the contract is specified as JSON schemas in `packages/contracts` (zod, with mirrored Python models). Domain modules (`probe`, `preprocess`, `measure`, `diarize`) must not depend on the HTTP framework.

### 3.2 Provider adapters (illustrative TypeScript)

*Implementation note (Phase 2C).* The interfaces are implemented in `packages/contracts/src/transcription.ts` with these differences from the sketch below: adapters also expose `model` and `mapRaw(payload, req)` (re-derives the neutral shape from a stored raw payload, so a retry never re-requests output already stored); `capabilities()` carries `fake`; the STT request carries the window (`index`, `startMs`, `endMs`), `audioDurationMs` and the `rawKey` the adapter must write the raw payload to atomically before returning (the raw store is write-once: an existing object is never replaced, and an object an earlier attempt stored before its row is adopted instead of re-requested); returned segment times are absolute on the canonical timeline; diarization requests carry an optional `window` (ADR-0016 hook, whole-file only is implemented) and `rawKey`. `confidence` is absent when the provider gives none. Provider output is validated before use (`apps/orchestrator/src/runs/validate.ts`): segment and diarization-turn intervals must be finite, start within `[0, duration)`, end after start and at most 1 s past the end (clamped to it); speaker keys are non-blank and at most 64 characters; confidences lie in [0, 1]. Otherwise the run fails `PROVIDER_OUTPUT_INVALID` on that stage. Only the `fake` adapters exist (`STT_PROVIDER` / `DIARIZATION_PROVIDER`; an unknown key stops the run workers at startup).

```ts
interface SpeechToTextProvider {
  readonly id: string;
  capabilities(): { languages: ('en'|'hi')[]; codeSwitching: boolean; wordTimestamps: boolean;
                    diarization: boolean; maxInputSeconds?: number };
  transcribe(req: { audioUri: string; offsetMs: number; languageHints?: ('en'|'hi')[] }): Promise<{
    raw: { payloadUri: string; sha256: string; providerModel: string };   // verbatim provider output, stored first
    segments: { startMs: number; endMs: number; text: string; language: 'en'|'hi'|'mixed';
                codeSwitchSpans?: { startChar: number; endChar: number; language: 'en'|'hi' }[];
                confidence?: number; words?: { startMs: number; endMs: number; text: string; confidence?: number }[];
                speaker?: string }[];
  }>;
}

interface DiarizationProvider {
  readonly id: string;
  diarize(req: { audioUri: string; durationMs: number; expectedSpeakers?: number }): Promise<{
    raw: { payloadUri: string; sha256: string };
    turns: { startMs: number; endMs: number; speakerKey: string; confidence?: number }[];
  }>;
}

// ADR-0017: question-level interface; works for server-side tools (e.g. Claude web search/fetch)
// and for client-side search + fetch implementations.
interface ResearchProvider {
  readonly id: string;
  research(req: {
    runId: string;
    questions: { id: string; text: string }[];          // already minimised (ADR-0009)
    constraints: { maxSourcesPerQuestion: number; allowDomains?: string[]; denyDomains?: string[] };
  }): Promise<{
    queriesIssued: { questionId: string; query: string }[];   // exactly what left the system
    findings: { questionId: string; sources: {
      url: string; title?: string; publisher?: string; publishedAt?: string; retrievedAt: string;
      retrieval: 'fetched' | 'snippet_only';
      snapshot?: { storageUri: string; sha256: string };     // required when retrieval = 'fetched'
      passages: { quotedText: string; locator?: string }[];  // verbatim from snapshot
    }[] }[];
    usage: { searches: number; costEstimate?: number };
  }>;
}
```

If a provider returns only snippets, the adapter fetches and snapshots the page itself. If fetching fails, the source is `snippet_only` and cannot support a verdict.

## 4. Long-audio processing

1. **Upload**: an upload session with a fixed part size. Cloud uses S3 multipart presigned URLs; local uses chunked PUT. `GET` on the session lists received parts so an interrupted upload can resume.
2. **Probe** (ingestion → audio service): deep validation. Invalid → recording `invalid` with a reason.
3. **Preprocess** (preprocessing node → audio service, deterministic): build a canonical record of the full configuration plus tool versions (audio service, Python, FFmpeg, librosa, NumPy, VAD implementation and version), hash it, and store **both the record and the hash** (ADR-0015). Reuse a matching `audio_preprocessings` row, otherwise create one. Streamed FFmpeg decoding and normalisation (canonical: mono, 16 kHz, s16 WAV, implemented in Phase 2B; formal acceptance pending the user's review), VAD (OD-29), segmentation with overlap.
4. **Measure and diagnose** (A1, in parallel with steps 5–10, ADR-0021): the audio service computes objective block-wise measurements (stored once per preprocessing version). A1 classifies them into run-scoped diagnostics and flags.
5. **Transcribe** (A2): a BullMQ flow with one child job per segment plus a parent completion job. Per-provider rate limiter, per-run fan-out cap (OPS-5). Each child stores raw output before parsing.
6. **Stitch** (A2): in overlap regions, keep words from the segment where the overlap is further from that segment's edge. Use word timestamps where available.
7. **Identify language** (A2): per segment, with code-switch spans. Uncertain cases → `language_uncertain`.
8. **Diarize** (A2, ADR-0016): memory must stay bounded for recordings of any length. Managed providers receive the storage URI. Self-hosted diarization uses whole-file processing only within the memory budget, otherwise a windowed approach with cross-window speaker matching to give global `speaker_key`s. Implemented (ADR-0037): whole file up to 10 min; else 10 min windows with 30 s overlap, one CAM++ embedding per window speaker, greedy one-to-one matching at cosine ≥ 0.5, turns clipped to each window's owned span.
9. **Align** (A2): assign each word/segment the speaker with the greatest overlap. Overlapping turns → `overlapping_speech` uncertainty.
10. **Persist** (A2) the machine transcript version v1 (immutable).

## 5. Queues (all owned by Node/NestJS, ADR-0002)

| Queue | Producer → Consumer | Notes |
|---|---|---|
| `run` | api → orchestrator | Starts or resumes a graph run (`runId`, `resume?`) |
| `audio-probe` | api (after upload complete, explicit start) → orchestrator | Phase 2B, implemented. Validation: `{workspaceId, recordingId, thenPreprocess}`, jobId `probe-<recordingId>`. Step job (`moveToDelayed` + `DelayedError`, poll 2 s) |
| `audio-preprocess` | api / orchestrator → orchestrator | Phase 2B, implemented. `{workspaceId, preprocessingId}`, jobId = preprocessingId. Step job; progress written on stage change, 1 % or 5 s; cancel checked each poll |
| `audio-sweep` | orchestrator (repeatable, 60 s) | Phase 2B, implemented. Re-enqueues stuck `queued`/`running` rows and `validating` recordings without a live job, else fails the row `TIMEOUT` (retryable) |
| `audio-task` | orchestrator → orchestrator | Generic step-job design. Phase 2B implements it as the dedicated `audio-probe` / `audio-preprocess` queues above; kept for later audio tasks (e.g. self-hosted diarization) |
| `run-transcription` | api / orchestrator → orchestrator | Phase 2C, implemented (D-2C-01, interim). `{workspaceId, runId}`, jobId = runId. One job runs the whole stage scope (transcription windows, then diarization, then atomic transcript v1) in one bounded loop, concurrency 1 (`QUEUE_RUN_CONCURRENCY`); cancel (`cancel_requested_at`, status `cancelling`), the deadline (`RUN_DEADLINE_MS`) and the per-call bound (`RUN_PROVIDER_TIMEOUT_MS`) are checked between windows; transient failures use BullMQ attempts and backoff (`QUEUE_RUN_ATTEMPTS`, `QUEUE_RUN_BACKOFF_MS`), then the run fails with a code. Stored raw outputs are reused on retry. Replaced by the LangGraph `run` queue and the per-segment flow below when agents are approved |
| `run-sweep` | orchestrator (repeatable, `RUN_SWEEP_INTERVAL_MS`) | Phase 2C, implemented. Re-enqueues stuck `queued`/`running` runs without a live job while `retry_count < RUN_MAX_RETRIES` (counted as a retry, audited `run.retried`), else fails them `TIMEOUT`; finishes a `cancelling` run without a job as `cancelled` |
| `stt-segment` | orchestrator (flow child) | One segment per job. Fake provider in development |
| `stt-complete` | orchestrator (flow parent) | Runs when all children finish → resume graph |
| `diarize` | orchestrator | Managed adapter call, or an audio-service task for self-hosted (implemented inside the `run-transcription` job, ADR-0037) |
| `export` | api → orchestrator | PDF/DOCX rendering |
| `deletion` | api → orchestrator | Recording deletion across all stores |

Every payload carries IDs only and is defined as a zod schema in `packages/contracts`. Bounds per queue (concurrency, attempts, backoff, timeout, stalled interval / max stalled count, retained failed jobs) come from config (ADR-0010).

## 6. Run control (ADR-0014)

- **Cancel**: API sets `cancel_requested_at` and status `cancelling`. The orchestrator stops starting nodes and child jobs, removes waiting child jobs, and calls `DELETE /v1/tasks/{id}` for in-flight audio tasks. In-flight LLM/provider calls finish and their results are discarded. Status becomes `cancelled`. Completed artefacts are kept (consistent, attributed to the run).
- **Retry**: allowed for `failed`/`cancelled` runs while `retry_count < run.maxRetries`. Resumes from the last checkpoint. Job-level automatic retries are separate and bounded.
- **Research retry**: one targeted pass for unresolved claims (`state.research.attempts ≤ 2`).

## 7. Errors

`ValidationError` (non-retryable), `ProviderError{retryable}`, `QuotaError`, `SchemaError`, `CancelledError`, `BudgetExceededError` (OD-28), `AudioTaskLostError` (retryable). Error messages and logs carry IDs and codes only, never content (SEC-9).

## 8. Configuration

Validated at startup (NestJS config schema; Python settings). Covers: providers, per-agent Claude model IDs, per-run cost ceiling, queue bounds, audio-task timeouts and memory budget, segment length/overlap (OD-10), diarization whole-file threshold, loop caps (QA, research retry = 1), max manual retries, research domain lists. No hard-coded vendor model IDs.

## 9. Frontend

- Routes: recordings, upload (with consent attestation), run detail (stage progress), transcript (version selector, speaker display names, uncertainty overlay, separate audio-diagnostics track, correction editor), report (HTML, provenance badges per assertion, separate limitation sections), exports.
  - Implemented in Phase 2A M7 (honest state, no report API yet): `/reports` (index of the workspace's recordings with report availability derived from `GET /recordings` `latestRun`) and `/recordings/{id}/report` (report reader structure; every report field shows "not available" until API §7 exists). See `docs/design/phase2a-m7/README.md`.
  - Implemented in Phase 2A M8 (honest state, no evidence API yet): `/recordings/{id}/evidence` (planned evidence chain, provenance and source-type explanations, and empty claims, research queries, sources, evidence passages and validation sections until API §6 exists). Linked from the report page and the recording detail Report card. See `docs/design/phase2a-m8/README.md`.
- The transcript is fetched by time range (no full load for long recordings). Types come from `packages/contracts`.
