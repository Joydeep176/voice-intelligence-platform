# Complete multi-agent product architecture (A1–A7) and dependency-aware roadmap

- **Status (2026-11-26):** the roadmap and A1–A7 identities were accepted with Phase 3A planning (ADR-0043–0047).
  Phase 3A (A1) is **implemented and accepted** (`PHASE3A_COMPLETION_REPORT.md`). Phases 3B and 3C are **not
  started or approved**; their designs below are planning only.
- **Graphify review (2026-11-26, report §6):**
  - no import cycles;
  - the shared stage table, run coordinator, audio-service task registry, database and contracts support adding A2–A7
    and the Phase 3C path without per-agent infrastructure;
  - noted for the agent phase: `STAGE_NODES` and the run/stage helpers would sit better in neutral run modules than
    in `audio-quality.ts` / `transcription.ts`.
- This document **extends** `docs/architecture/AGENT_ARCHITECTURE.md`, which stays authoritative for agent identities,
  boundaries, the graph topology and contracts. It is not repeated here.
- It covers what that document leaves open:
  - how the agents are orchestrated in practice on this codebase and this hardware;
  - shared services;
  - how new agents are added without a redesign;
  - the open decisions that block each later phase.

## 1. Ground truth today (from the code, not the docs)

- **Agents:** no product agent exists. LangGraph is not a dependency; it is mentioned in comments only.
- **The "pipeline":**
  - the preprocessing flow (`audio-probe` → `audio-preprocess`, BullMQ step jobs);
  - one `run-transcription` job that runs the A2 stage scope (windows → STT → diarize → transcript v1) sequentially;
  - `pipeline_runs` and `pipeline_stage_runs` (`RUN_STAGES` = `transcription`, `diarization`).
- **Graph-related records that exist only as design:**
  - OD-04b (LangGraph orchestrates) is *Accepted provisionally*;
  - ADR-0021 (A1 ∥ A2) is *Accepted provisionally, pending graph validation*;
  - ADR-0018 (progress propagation) is provisional.
- **Runtime constraint for LLM agents (A3–A7):** ADR-0034 forbids paid LLM APIs, and OD-47 (production LLM runtime)
  is **Open**. Every LLM agent is therefore blocked on OD-47; A1 is not, because it uses no LLM.

## 2. Agent responsibilities and interfaces

| Agent | Nature | Input (only) | Output state key | Writes | Phase |
| --- | --- | --- | --- | --- | --- |
| Preprocessing (not an agent) | Deterministic | Recording | `preprocessingId` | Preprocessing tables, measurements | Done (2B) |
| **A1 Audio Quality** | Deterministic rules (ADR-0043, Accepted) | Preprocessing version + measurement set | `audioQuality` (`AudioQualitySummary`) | `audio_diagnostics`, `audio_diagnostic_flags` | **3A** |
| A2 Transcription | Provider adapters (self-hosted) | Preprocessing version (segments/windows); *optional* read-only A1 context (ADR-0046, Accepted) | `transcript` | Transcription tables | Foundation done (2C); agent-ification later |
| A3 Context Intelligence | LLM (OD-47) | Transcript version; *optional* read-only A1 context (ADR-0046, Accepted) | `context` | `topics`, `entities`, `claims` | 3B |
| A4 Research | Tool-using LLM + `ResearchProvider` (OD-05) | Claims + context | `research` | `research_queries`, `research_sources` | After 3C |
| A5 Fact Validation | LLM over evidence | Claims + sources | (`context.unresolvedClaimIds`) | `claim_evidence`, `claim_validations` | After A4 |
| A6 Reporting | LLM structured generation | All artefacts: **A1 summary + flags**, A2–A5 | `reportId` | `reports`, `report_assertions`, `assertion_refs` | After A5 |
| A7 QA | Rules + LLM, read-only | Report + every referenced artefact, incl. A1 summary | `qa` | `qa_reviews`, `qa_issues` | After A6 |

**A1 interactions** (ADR-0046, Accepted: read-only metadata). Availability is kept separate from dependency and
from coupling:

- **A2:**
  - It *may* read `AudioQualityContext` (constraints and affected time ranges).
  - It never waits for A1. Its behaviour does not change in 3A; future use needs its own ADR and the accuracy gate.
  - It never derives uncertainty from diagnostics.
- **A3:**
  - It *may* read the context as reliability metadata for transcript-derived information. It stores references only,
    and its quoted text and extraction logic are unaffected.
  - It never waits for A1, so it still runs on corrected transcripts (ADR-0020).
- **A4, A5:** no interaction. Audio quality says nothing about external evidence.
- **Phase 3C capability** (ADR-0047, Accepted): it *may* read the context under the same rules. A1 never classifies
  sound sources.
- **A6:** consumes the summary and flags for the mandatory *Audio limitations* section (ADR-0008), and the time overlap
  with assertion spans for per-assertion caveats.
- **A7:** checks that the report's audio statements are consistent with the summary, and checks that diagnostics and
  uncertainty are not conflated (`qa_issues.kind = diagnostics_uncertainty_conflation`, FR-10.2).

## 3. Orchestration design

### 3.1 Two layers: the same roles as ADR-0002, made concrete

```
             ┌──────────────────────── Run coordinator (orchestrator) ─────────────────────────┐
 API ─run──► │  graph definition (nodes, edges, routing)  +  checkpoint store (Postgres)       │
             │       │ node = "start BullMQ job(s), persist outputs, write state key"           │
             └───────┼─────────────────────────────────────────────────────────────────────────┘
                     ▼
     BullMQ queues (bounded workers, ADR-0010) ─► audio service tasks / LLM runtime / research provider
```

- **Graph layer:** decides *what runs next*.
  - Nodes, required upstream results (AGENT §2.1), conditional routing and the A6 join.
  - Its state holds IDs and small summaries only, never content (AGENT §3).
- **Job layer:** BullMQ owns *how long work runs*.
  - Retries, backoff, timeouts, cancellation, sweepers.
  - It already exists and is proven in 2B/2C (step jobs, idempotency keys, raw-output reuse).

### 3.2 One shared orchestration target; when LangGraph arrives (decision D-3A-02)

- **Target, unchanged (OD-04b):** one shared LangGraph graph orchestrates the whole platform: preprocessing, A1–A7 and
  the Phase 3C path. There is no per-agent orchestration system.
- **Phase 3A (recommended option B):** the implementation uses BullMQ inside the *existing* run coordinator. A1 gets
  no orchestration of its own.
  - A1's node boundary is framework-independent and lives in `packages/contracts`: `A1NodeInput`, `A1NodeOutput` and
    the `audioQuality` state slice.
  - The node is a pure function (`(A1NodeInput, ports) → A1NodeOutput`) behind a repository and the reader port.
  - The BullMQ job is only an adapter around it, so A1 joins the shared graph as a node without redesign.
  - Introducing LangGraph now would mean refactoring the accepted 2B/2C coordinator for a single deterministic node,
    with no LLM, loop or join yet to justify it.
- **Phase 3B (first LLM agent A3, first real chain A2 → A3):** introduce the graph layer behind a prototype that
  validates ADR-0002's list (checkpoint resume, pause during long BullMQ jobs, cancellation, progress relay) and
  ADR-0021's graph-level tests.
  - **Library:** `@langchain/langgraph` with a Postgres checkpointer. Its licence and versions must be checked at that
    time (ADR-0034), and it needs dependency approval.
  - **If the prototype fails:** OD-04b is revisited *with the user*, and its target is not dropped silently. Because
    node contracts are framework-independent, agents are unaffected either way.

### 3.3 Shared state and communication

- **One state key per agent**, written only by that agent (AGENT §2.2). Shared keys (`errors`) use append reducers.
  Other nodes may *read* a key only where an ADR allows it. ADR-0046 (Accepted) lets A2, A3, A6, A7 and the 3C path
  read `audioQuality`.
- **Handoffs are by reference:** state carries IDs (`diagnosticsId`, `transcriptVersionId`, `claimIds`), and agents
  read full artefacts from their own read repositories. There is no message passing between agents and no shared
  memory store.
- **Contracts:** every input, output and state slice is a zod schema in `packages/contracts`, with Python mirrors where
  the audio service is involved. A new agent adds:
  - its schema;
  - its tables (one migration);
  - its repository (write surface limited to its own tables);
  - its node and its value in the stage-node enum (`STAGE_NODES`). `RUN_STAGES` stays the transcription run scope
    (ADR-0044, Accepted).
  Nothing else changes. This is the "no redesign" property.

### 3.4 Execution order, parallelism and routing

| Rule | Behaviour |
| --- | --- |
| Sequential chain | A2 → A3 → A4 → A5 → A6 → A7 (each needs the previous output) |
| Parallel | A1 ∥ (A2 … A5) after preprocessing (ADR-0021): neither *waits* for the other. A2 and A3 may *read* the A1 summary when present (ADR-0046, Accepted). On this hardware, "parallel" is logical: the audio service runs one task at a time, and A1's classification costs milliseconds. In 3A, A1 runs before transcription is started (Accepted, D-3A-03 / ADR-0044). The Phase 3C path is a further branch after preprocessing (ADR-0047, Accepted) |
| Join | A6 waits for A1 **and** A5. It is the only join |
| Conditional: corrected-transcript run | Skips preprocessing, A1 and A2 and references the parent run's diagnostics (ADR-0020, OD-26b *Proposed*) |
| Conditional: research retry | A5 → A4 targeted retry once (ADR-0014) |
| Conditional: QA failure | OD-14 (*Proposed*): limited A6 revisions, then `needs_review` |
| Conditional: no speech (`insufficient`) | **No automatic skip or block** (ADR-0008; the user's review, 2026-11-26). Any future skip needs a separate ADR |
| Not every agent for every recording | A1 and A2 always run for new audio. Whether A3–A7 run on request is deferred to 3B planning (D-3A-11) |

### 3.5 Error handling and retries

- **Job level:** BullMQ attempts and backoff from config (existing). Transient errors (`TransientRunError`) are retried;
  deterministic errors fail fast.
  - Pre-existing finding: `RESOURCE_EXHAUSTED` and `TIMEOUT` are retried even when deterministic. This was recorded at
    the 2B/2C closure and should be revisited before more audio tasks are added.
- **Node level:**
  - A failure is recorded on `pipeline_stage_runs(node, attempt)` with a code.
  - Downstream nodes that *need* the result do not start; independent branches continue. An A1 failure blocks only
    A6, per ADR-0021.
- **Run level:** retry resumes from the last completed node (checkpoint), with outputs reused because they are keyed
  by (`run_id`, node, attempt) and through raw-output reuse.
- **Budget:** cost ceilings in compute and time (ADR-0034 consequence; OD-28 *Proposed*), checked before every LLM
  call.

### 3.6 Avoiding duplicate processing and conflicting outputs

- **Deterministic work is cached by config hash:** preprocessing (ADR-0015) and A1 measurement sets.
- **Provider calls are idempotent:** content-derived idempotency keys and raw-output reuse (2C).
- **One writer per table**, enforced at the repository layer and tested.
- **Immutable outputs with versions:** raw outputs and machine transcripts (ADR-0007), measurements and diagnostics.
  "Re-doing" an agent creates a new attempt or version and never overwrites, so two runs cannot conflict.
- **Single active run per recording at a time:** the existing duplicate-submission guard (2C failure-path evidence).

### 3.7 Shared services and reusable tools

| Service | Status | Used by |
| --- | --- | --- |
| Audio service task API (probe, preprocess, transcribe, diarize, **measure**) | Exists, plus `measure` (3A) | Preprocessing, A1, A2 |
| Object storage (local root; S3 is OD-48) | Exists | All |
| Repositories per agent (Drizzle) | Pattern exists (2B/2C) | All |
| LLM factory (per-agent model config, budget, `llm_calls`) | Designed (ADR-0013); runtime **OD-47 Open** | A3–A7 |
| Research provider adapter | Designed (ADR-0017); provider **OD-05 Open** | A4 |
| Prompt registry (versioned prompts next to each agent) | Designed (AGENT §5) | A3–A7 |
| Observability | Content-free structured logs exist; OD-15 Open | All |

### 3.8 Observability and tracing

- **Trace key = `runId`.** Every job, audio task, stage row and log line carries `runId`, `node` and `attempt`. These
  are IDs only (SEC-9).
- **`pipeline_stage_runs`** is the execution trace per node: status, progress, timings, error code, job IDs. A1 adds
  the `audio_quality` rows in 3A.
- **`llm_calls`** (designed) records model, tokens and latency per call for A3–A7. There is no prompt or response
  text.
- Run detail in the UI already shows stage progress. Each agent becomes one more stage there.

## 4. Hardware envelope for the full system (M1, 8 GB)

| Component | Memory (indicative) | Note |
| --- | --- | --- |
| Audio service | 768 MB cap | Accepted (ADR-0039 / ADR-0041) |
| Postgres + Redis + API + orchestrator + web dev servers | About 1–1.5 GB | Development |
| Docker VM and macOS overhead | Several GB | Shared unified memory |
| **Local LLM for A3–A7 (OD-47)** | About 2–3 GB for a 3–4B 4-bit model; about 5 GB for 7–8B | **The main feasibility risk of the later phases.** It runs one LLM agent at a time, ideally never concurrently with STT |

A1 adds no standing memory. Its measure task runs inside the existing audio-service cap.

## 5. Dependency-aware roadmap (sequence unchanged from the user's roadmap)

| Phase | Scope | Hard prerequisites (decisions) | Builds on |
| --- | --- | --- | --- |
| **3A** | A1 Audio Quality (this plan) | D-3A-00 before M0; D-3A-01–07 and D-3A-09 before M1; D-3A-08 / D-3A-10 at M6. D-3A-11 and the 3C design are **not** prerequisites | 2B measurements, 2C VAD, run lifecycle |
| **3B** | A3 Context Intelligence | **OD-47** (LLM runtime within ADR-0034); OD-07 conflict resolution; graph-layer prototype (OD-04b, ADR-0002 list, ADR-0021 validation); LLM golden sets (TESTING §4) | A2 transcript v1; graph layer |
| **3C** | Machinery and environmental sound intelligence: a **distinct** intelligence path (ADR-0047, Accepted), not part of A1 or A3 | The SRS C-4 amendment (ADR-0047); agent or capability; model or algorithm within ADR-0034; contracts | Shared audio-service task pattern, storage, contracts, graph, observability; optional read-only A1 context (ADR-0046) |
| A4 | Research | **OD-05** (free, self-hostable provider), OD-09b (snapshot retention) | A3 claims |
| A5 | Fact Validation | OD-30 taxonomy | A4 sources |
| A6 | Reporting | OD-25 (export library) | **A1** + A5 (join) |
| A7 | QA | OD-14 | A6 |
| 8 | Production readiness | OD-08b, OD-27, OD-48, OD-23c, OD-09b, OD-17, OD-15 | All |

## 6. Reserved Phase 3C path (ADR-0047, Accepted; design deferred to Phase 3C)

```
preprocessing ─┬─► A1 Audio Quality ───────────────┐
               ├─► A2 Transcription → A3 → A4 → A5 ├─► A6 Reporting → A7 QA
               └─► Phase 3C sound intelligence ─────┘   (consumers decided in 3C)
```

- **Distinct identity:** it is not A1, which assesses audio fitness and never says what a sound is, and not A3, which
  works over the transcript.
- **Shared infrastructure:** the same audio service (a new sandboxed, bounded task type), storage, `packages/contracts`
  schemas, the shared graph (its own node(s), stage-node value and state key), `pipeline_stage_runs` tracing and logs.
- **No separate product, database, orchestration or deployment.**
- **SRS C-4 amendment accepted** (ADR-0047). Whether 3C is an agent is decided in 3C.
