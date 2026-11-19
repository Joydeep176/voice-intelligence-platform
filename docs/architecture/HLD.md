# High-Level Design (HLD)

Status: **Approved baseline + accepted ADRs + labelled proposals.** Text tagged *Proposed* is **not approved**. Decisions are in `docs/architecture/adr/` and tracked in §10.
No application code exists; this document describes the target system.

Related: [SRS](../SRS.md) · [LLD](LLD.md) · [Agents](AGENT_ARCHITECTURE.md) · [Database](DATABASE_DESIGN.md) · [API](API_SPECIFICATION.md) · [Deployment](DEPLOYMENT_ARCHITECTURE.md) · [Testing](TESTING_STRATEGY.md) · [Review](ARCHITECTURE_REVIEW.md)

## 1. Purpose

A general-purpose multilingual AI Voice Intelligence Platform for **English, Hindi and Hinglish**. It turns audio, from short voice notes to recordings **longer than two hours**, into an evidence-backed intelligence report.

## 2. Approved technology baseline

| Concern | Technology |
|---|---|
| Frontend | React + TypeScript + Vite, Tailwind CSS + shadcn/ui (Radix UI base, ADR-0022) |
| Backend API | Node.js + NestJS + TypeScript |
| AI orchestration | LangChain.js + LangGraph.js |
| Primary LLM | Anthropic Claude API (model per agent configurable, ADR-0013) |
| Speech-to-text | Configurable provider adapter (fake adapter first, ADR-0012) |
| Audio processing | Python + FFmpeg + librosa + NumPy, as a separate deterministic service (ADR-0002, ADR-0019) |
| Speaker diarization | pyannote.audio or managed provider, part of the transcription stage (benchmark before production, ADR-0012) |
| Database | PostgreSQL + pgvector (embeddings not used for now, ADR-0011) |
| Background processing | Redis + BullMQ, owned by Node/NestJS (ADR-0002) |
| Object storage | Local filesystem (dev), Amazon S3 (cloud) |
| Workspace tooling | pnpm + Turborepo, uv, Drizzle ORM (ADR-0005) |
| Testing | Vitest, Jest, Pytest, Playwright |
| Deployment | Docker Compose (local), AWS ECS + RDS + S3 (production) |

## 3. Workflow, deterministic stages and agents

Workflow (approved): 1 ingestion & validation · 2 preprocessing & segmentation · 3 audio quality & distortion analysis · 4 transcription · 5 diarization · 6 context intelligence · 7 deep internet research · 8 fact verification · 9 report generation · 10 quality assurance.

| Step(s) | Owner | Kind |
|---|---|---|
| 1 | Ingestion: API + audio-service probe | Deterministic, not an agent |
| 2 | **Audio-processing service**: FFmpeg decoding, normalisation, VAD, segmentation (ADR-0019) | Deterministic, not an agent |
| 3 | A1 **Audio Quality Agent**: analyses objective audio measurements and produces its own diagnostic output. Runs in parallel with A2 (ADR-0021) | Agent |
| 4, 5 | A2 **Transcription Agent**: transcription, language identification, diarization, transcription uncertainty | Agent |
| 6 | A3 Context Intelligence Agent | Agent |
| 7 | A4 Research Agent | Agent |
| 8 | A5 Fact Validation Agent | Agent |
| 9 | A6 Reporting Agent | Agent |
| 10 | A7 QA Agent (independent, read-only) | Agent |

Exactly seven agents (ADR-0001, as amended by ADR-0019). Audio diagnostics (A1) and transcription uncertainty (A2) are separate. Details: [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md).

## 4. System context

```
  User ──▶ Web (React) ──HTTPS──▶ API (NestJS) ──────────────▶ Object storage
                 ▲  progress            │  │                    (local FS / S3)
                 │  (OD-16)             │  │ enqueue / QueueEvents     ▲
                 └──────────────────────┘  ▼                           │
                               Redis (BullMQ, owned by Node)           │
                                           │                           │
                                           ▼                           │
                       Orchestrator (NestJS: BullMQ workers, LangGraph,│
                       deterministic preprocessing node, 7 agents,     │
                       provider adapters) ─────────────────────────────┤
                         │       │ internal HTTP API (ADR-0002)        │
                         │       ▼                                     │
                         │   Audio service (Python, deterministic:     │
                         │   decode, normalise, VAD, segment, measure; │
                         │   self-hosted diarization if chosen) ───────┘
                         │
                         ├─▶ PostgreSQL (+pgvector ext., LangGraph checkpoints)
                         ├─▶ Claude API
                         ├─▶ STT / diarization providers (fakes in development)
                         └─▶ Research provider (OD-05)
```

## 5. Runtime components

| Component | Responsibility |
|---|---|
| `web` | Upload with consent attestation, run monitoring, transcript viewer and corrections, HTML report, export download |
| `api` | Authentication (IdP open), workspace authorisation, uploads, shallow validation, CRUD, progress stream, audit events |
| `orchestrator` | Owns BullMQ jobs and their lifecycle, LangGraph execution (deterministic preprocessing node + 7 agents), provider adapters, cost tracking, all Postgres writes for pipeline artefacts |
| `audio-service` | Stateless, deterministic internal service: probe, decode/normalise, VAD, segmentation, objective audio measurements, self-hosted diarization if chosen. Reads and writes object storage. Never writes to Postgres or Redis. Makes no quality judgements; A1 does that |
| `postgres` | System of record. pgvector extension enabled, no embedding tables. LangGraph checkpoints |
| `redis` | BullMQ only |

## 6. Architectural principles

1. **Asynchronous and durable.** Background jobs, checkpointed in Postgres, resumable.
2. **Bounded processing.** Concurrency, timeouts, retry caps, loop caps and per-run cost ceilings (ADR-0010).
3. **State by reference.** Graph state holds IDs and summaries.
4. **Provider isolation.** STT, diarization, research and LLM go through adapters. Fakes are used until providers are selected.
5. **Immutable source data.** Original audio and original provider output are never modified. Corrections, transliterations and translations are separate versions (ADR-0007).
6. **Provenance on every assertion:** `recorded`, `external` or `inferred`.
7. **Two separate uncertainty channels.** Audio diagnostics (A1) and transcription uncertainty (A2) are separate data models and report sections.
8. **Evidence, not snippets.** Verdicts need evidence quoted from snapshotted source content.
9. **Independent QA.** A7 reads everything and writes only QA records.
10. **Deterministic processing separate from judgement.** The audio service measures and transforms. Agents interpret.
11. **Workspace isolation and privacy by default.** No raw audio, transcript text or secrets in logs, traces or Git.

## 7. Long recordings (> 2 h)

- Multipart, resumable uploads straight to storage.
- The audio service streams decoding and processes audio in blocks, with bounded memory per task.
- Preprocessing outputs are versioned and reused across runs (ADR-0015). Every hash is stored with the full reproducible configuration and tool-version metadata it was computed from.
- After preprocessing, the Audio Quality and Transcription agents run independently in parallel (ADR-0021, provisional). Transcription fans out per segment as BullMQ child jobs; results are stitched using overlaps.
- Diarization (transcription stage) must use bounded memory for recordings of any length (ADR-0016). Managed providers receive a storage reference. For self-hosted diarization, thresholds and the windowing/clustering algorithm are set by benchmark (OD-03b).
- LLM stages: a full 2 h transcript generally fits current Claude context windows. Each agent picks full-context or hierarchical processing within its budget (ADR-0013).

## 8. Multilingual

- Original script and code-switching are preserved as produced (ADR-0007). The Transcription Agent owns language identification (per segment, with code-switch spans).
- Transliteration and translation are separate derived representations. How they are generated and triggered is OD-24b.
- Reports default to English, with Hindi as an option (ADR-0006).

## 9. Security & privacy (summary)

Requirements in SRS §3.12. Workspace ownership (ADR-0003); consent attestation; synthetic or consented development data (ADR-0004); encryption at rest and in transit; configurable retention; complete deletion (DATABASE_DESIGN §6); minimised, logged external research (ADR-0009); append-only audit events. The role model, authorisation and database isolation must be defined before multi-user access (OD-27). The full production data policy is OD-09b.

## 10. Decisions register

**Statuses** (only these are used):
- **Accepted**: the user decided; scope settled.
- **Accepted provisionally**: the user decided, subject to a stated validation.
- **Interim**: the user approved an approach for now; the final decision is still to be made.
- **Proposed**: a specific option has been put forward for approval, by the user or in a *Proposed* ADR, but is not accepted.
- **Open**: no decision; any suggestion noted is the assistant's and not endorsed.

Decisions with mixed scope are split into a/b rows so each row has one status.

| ID | Decision | Resolution / proposal | Status | Record |
|---|---|---|---|---|
| OD-01 | Step-to-agent mapping | Seven agents; preprocessing is deterministic in the audio service; diarization in the transcription stage | Accepted | ADR-0001, ADR-0019 |
| OD-02a | STT for development | Fake adapter | Interim | ADR-0012 |
| OD-02b | STT production provider | Benchmark before selection | Open | — |
| OD-03a | Diarization for development | Fake adapter | Interim | ADR-0012 |
| OD-03b | Diarization production implementation, including the ADR-0016 thresholds and windowing algorithm | Benchmark pyannote.audio vs managed | Open | — |
| OD-04 | Node ↔ Python integration | Node owns BullMQ/job lifecycle; LangGraph orchestrates; Python service behind an internal API | Accepted provisionally (prototype) | ADR-0002 |
| OD-05 | Research provider | Assistant suggestion: Claude server-side web search/fetch behind the ADR-0017 interface | Open | — |
| OD-06 | Embeddings | Not used until a retrieval use case is demonstrated | Interim | ADR-0011 |
| OD-07 | Claude model per agent; cost | Configurable per agent; cost tracked per call and per run | Accepted | ADR-0013 |
| OD-08a | Tenancy | Workspace-based ownership and isolation | Accepted | ADR-0003 |
| OD-08b | Authentication provider | — | Open | — |
| OD-09a | Development data | Synthetic or explicitly consented audio only | Interim | ADR-0004 |
| OD-09b | Production privacy & data-handling policy, including retention and copyright handling of research source snapshots (ADR-0017) | Required before production | Open | — |
| OD-10 | Limits & targets (formats, size/duration, segment length/overlap, latency) | — | Open | — |
| OD-11 | Tooling, ORM | pnpm, Turborepo, uv, Drizzle; verify pgvector compatibility before implementation | Accepted provisionally (verification) | ADR-0005 |
| OD-12 | Report formats & language | HTML in-app; PDF/DOCX exports; English default, Hindi option | Accepted | ADR-0006 |
| OD-13 | Hindi/Hinglish script | Preserve original script and code-switching; transliteration/translation are separate derived representations | Accepted | ADR-0007 |
| OD-14 | QA failure behaviour | Limited QA revision attempts, then human review (`needs_review`) | Proposed | — |
| OD-15 | Observability | Assistant suggestion: content-free structured logs; OpenTelemetry later | Open | — |
| OD-16 | Progress transport to client | SSE (with polling fallback) | Proposed | — |
| OD-17 | IaC and CI/CD | — | Open | — |
| OD-18 | Test audio corpus | — | Open | — |
| OD-19 | Poor-quality audio | Continue where possible; report limitations | Accepted | ADR-0008 |
| OD-20 | Research privacy | Research mandatory; query minimisation and privacy controls | Accepted | ADR-0009 |
| OD-21 | Worker bounds | Required; numeric values set in configuration | Accepted | ADR-0010 |
| OD-22 | Transcript corrections | Versioned; never overwrite provider output; display names separate from machine IDs | Accepted | ADR-0007 |
| OD-23a | Python service framework | FastAPI preferred. The service contract stays framework-independent until a prototype validates the choice | Proposed | ADR-0002 (constraint) |
| OD-23b | Service-to-service authentication | — | Open | — |
| OD-24a | Storage of translations/transliterations | Original preserved; translation and transliteration stored separately | Accepted | ADR-0007 |
| OD-24b | How translations/transliterations are generated and triggered | — | Open | — |
| OD-25 | PDF/DOCX export library | Deferred to implementation by user decision | Open | — |
| OD-26a | Processing corrected transcripts | Must create traceable transcript versions and new processing runs | Accepted | ADR-0020 |
| OD-26b | Mechanism for corrected-transcript runs | New run with `sourceTranscriptVersionId`, starting at Context Intelligence (ADR-0020 §Proposed) | Proposed | ADR-0020 |
| OD-27 | Workspace roles, authorisation, database isolation (incl. RLS) | Must be defined before multi-user access is implemented | Open (blocks multi-user) | — |
| OD-28 | Cost ceiling behaviour | Stop further expensive processing; preserve completed results | Proposed | — |
| OD-29 | VAD implementation | Benchmarking WebRTC VAD and Silero VAD is approved (benchmark only; no selection, and either would be a new dependency added only when the benchmark is set up) | Open | — |
| OD-30 | Claim verdict taxonomy | `supported`, `contradicted`, `partially_supported`, `unverifiable`, `not_checkable` | Proposed | — |
| OD-31 | SRS assumptions A-1 (batch only) and A-2 (three languages only) | As stated in SRS §2.3 | Proposed | — |
| OD-32 | Run A1 and A2 in parallel after preprocessing | Independent parallel branches; downstream agents wait for their required upstream results. Subject to graph-level validation | Accepted provisionally (graph validation) | ADR-0021 |
| OD-33 | Motion (`motion`) for UI animation | Proposed as an optional frontend dependency; not approved; no Motion+ (paid) features | Proposed | — |
| OD-34 | Three.js + React Three Fiber + Drei for optional 3D views | Proposed as optional; lazy-loaded with a functional 2D alternative; not approved | Proposed | — |
| OD-35 | Waveform / timeline rendering library | No candidate selected (a dependency-free canvas renderer is possible) | Open | — |
| OD-36 | Charting library | No candidate selected | Open | — |
| OD-37 | List/transcript virtualisation library | No candidate selected | Open | — |
| OD-38 | Fonts, including a Devanagari-capable face | No candidate selected (system font stack until decided) | Open | — |
| OD-39 | Server-side waveform peaks artefact and API endpoint | Precompute waveform peaks per preprocessing version in the audio service and serve them by time range, so the browser never decodes long recordings. For later consideration; not part of the current architecture | Proposed | — |
| OD-40 | shadcn/ui component base (primitive library) | Radix UI; scaffold with `shadcn init --base radix` because the CLI now defaults to Base UI | Accepted | ADR-0022 |

Frontend dependencies (OD-33 to OD-38) are **not** part of the approved stack in §2. Each needs separate approval before installation.

**Design ADRs:**
- ADR-0015 preprocessing versions: Accepted
- ADR-0016 bounded-memory diarization: Accepted (principle; thresholds/algorithm under OD-03b)
- ADR-0017 research adapter and evidence: Accepted (snapshot retention under OD-09b)
- ADR-0018 progress propagation: Accepted provisionally (prototype; transport OD-16)
- ADR-0021 parallel Audio Quality and Transcription: Accepted provisionally (graph validation)
- ADR-0014 run control (safe cancellation, bounded retries, one targeted research retry): Accepted
