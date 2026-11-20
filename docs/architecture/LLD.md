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
| `storage` | `StorageService`: `LocalStorage` / `S3Storage`, signed URLs |
| `queue` | BullMQ producers + `QueueEvents` subscriber for progress |

### 2.2 `apps/orchestrator`
| Module | Responsibility |
|---|---|
| `graph` | LangGraph definition, state, Postgres checkpointer, pause/resume |
| `graph/nodes/preprocessing` | Deterministic preprocessing node (step 2, ADR-0019). Not an agent; no LLM |
| `agents/<agent>` | `audio-quality`, `transcription`, `context-intelligence`, `research`, `fact-validation`, `reporting`, `qa`: node, prompts, schemas |
| `providers/stt` | `SpeechToTextProvider` + `FakeSpeechToTextProvider` (real providers after benchmark) |
| `providers/diarization` | `DiarizationProvider` + fake, + `AudioServiceDiarizationProvider` if self-hosted |
| `providers/research` | `ResearchProvider` (ADR-0017) + fake |
| `providers/llm` | Claude factory: per-agent model config, retries, budget check, `llm_calls` recording |
| `audio-client` | Typed client for the audio-service internal API |
| `workers` | BullMQ processors (see §5) |
| `exports` | PDF/DOCX rendering jobs (tooling OD-25) |
| `deletion` | Recording deletion job (DATABASE_DESIGN §6) |

### 2.3 `services/audio` (Python, deterministic service; no DB/Redis access; ADR-0002, ADR-0019)
| Module | Responsibility |
|---|---|
| `api` | Internal HTTP adapter. FastAPI + uvicorn, provisionally (OD-23a, ADR-0023). The contract is defined independently of the framework (§3.1) until the prototype validates the choice |
| `tasks` | In-process bounded task executor: concurrency limit, per-task timeout, memory budget, cancellation |
| `probe` | ffprobe deep validation (step 1) |
| `preprocess` | Step 2: streamed FFmpeg decoding and normalisation, VAD (method OD-29; WebRTC VAD and Silero VAD to be benchmarked), segmentation with overlap. Returns its configuration and tool-version metadata with every result |
| `measure` | Objective block-wise audio measurements (librosa/NumPy, streamed reads) requested by A1. No classification or judgement |
| `diarize` | pyannote.audio, only if self-hosted (ADR-0012, ADR-0016); invoked by A2 |

## 3. Interfaces

### 3.1 Audio-service internal API (ADR-0002, *Proposed* shape, to be validated by prototype)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/tasks` | Submit `{ type: probe\|preprocess\|measure\|diarize, idempotencyKey, input: { storageUri, ... }, config }` → `202 { taskId }`. Same `idempotencyKey` → same task |
| GET | `/v1/tasks/{taskId}` | `{ status: queued\|running\|succeeded\|failed\|cancelled, progress: { fraction, processedMs, stage }, result?, error? }` |
| DELETE | `/v1/tasks/{taskId}` | Cooperative cancellation |
| GET | `/health/live`, `/health/ready` | Probes |
| POST | `/v1/handshake` | **Implemented Phase 1 prototype.** `{ contractVersion, requestId }` → `{ contractVersion, serviceVersion, requestId, accepted }`; unknown version → `422 CONTRACT_VERSION_MISMATCH`. Used by the API health check to verify reachability and contract compatibility |

- Results are JSON metadata plus storage URIs (artefacts written to object storage by the service). Node persists the metadata to Postgres.
- Task state is in memory. If the service restarts, the task disappears (`404`); Node treats that as retryable and resubmits with the same idempotency key, within retry bounds.
- Internal only (private network). Service-to-service authentication: OD-23b.
- **Framework independence** (ADR-0002 constraint): the contract is specified as JSON schemas in `packages/contracts` (zod, with mirrored Python models). Domain modules (`probe`, `preprocess`, `measure`, `diarize`) must not depend on the HTTP framework.

### 3.2 Provider adapters (illustrative TypeScript)

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
3. **Preprocess** (preprocessing node → audio service, deterministic): build a canonical record of the full configuration plus tool versions (audio service, Python, FFmpeg, librosa, NumPy, VAD implementation and version), hash it, and store **both the record and the hash** (ADR-0015). Reuse a matching `audio_preprocessings` row, otherwise create one. Streamed FFmpeg decoding and normalisation (*Proposed* canonical: mono, 16 kHz, lossless), VAD (OD-29), segmentation with overlap.
4. **Measure and diagnose** (A1, in parallel with steps 5–10, ADR-0021): the audio service computes objective block-wise measurements (stored once per preprocessing version). A1 classifies them into run-scoped diagnostics and flags.
5. **Transcribe** (A2): a BullMQ flow with one child job per segment plus a parent completion job. Per-provider rate limiter, per-run fan-out cap (OPS-5). Each child stores raw output before parsing.
6. **Stitch** (A2): in overlap regions, keep words from the segment where the overlap is further from that segment's edge. Use word timestamps where available.
7. **Identify language** (A2): per segment, with code-switch spans. Uncertain cases → `language_uncertain`.
8. **Diarize** (A2, ADR-0016): memory must stay bounded for recordings of any length. Managed providers receive the storage URI. Self-hosted diarization uses whole-file processing only within the memory budget, otherwise a windowed approach with cross-window speaker matching to give global `speaker_key`s. Thresholds and algorithm are set by benchmark (OD-03b).
9. **Align** (A2): assign each word/segment the speaker with the greatest overlap. Overlapping turns → `overlapping_speech` uncertainty.
10. **Persist** (A2) the machine transcript version v1 (immutable).

## 5. Queues (all owned by Node/NestJS, ADR-0002)

| Queue | Producer → Consumer | Notes |
|---|---|---|
| `run` | api → orchestrator | Starts or resumes a graph run (`runId`, `resume?`) |
| `audio-task` | orchestrator → orchestrator | Submits an audio-service task, then polls it using the *step-job* pattern (re-delays itself; no worker blocked). Relays progress (ADR-0018) |
| `stt-segment` | orchestrator (flow child) | One segment per job. Fake provider in development |
| `stt-complete` | orchestrator (flow parent) | Runs when all children finish → resume graph |
| `diarize` | orchestrator | Managed adapter call, or an `audio-task` for self-hosted |
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
- The transcript is fetched by time range (no full load for long recordings). Types come from `packages/contracts`.
