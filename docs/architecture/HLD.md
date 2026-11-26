# High-Level Design (HLD)

Status: **Approved baseline + accepted ADRs + labelled proposals.** Text tagged *Proposed* is **not approved**. Decisions are in `docs/architecture/adr/` and tracked in §10.
Implementation status: the Phase 1 foundation and the Phase 2A frontend are implemented; agents and the processing pipeline are not. This document describes the target system. See `docs/PROJECT_STATUS.md`.

Related: [SRS](../SRS.md) · [LLD](LLD.md) · [Agents](AGENT_ARCHITECTURE.md) · [Database](DATABASE_DESIGN.md) · [API](API_SPECIFICATION.md) · [Deployment](DEPLOYMENT_ARCHITECTURE.md) · [Testing](TESTING_STRATEGY.md) · [Review](ARCHITECTURE_REVIEW.md)

## 1. Purpose

A general-purpose multilingual AI Voice Intelligence Platform for **English, Hindi and Hinglish**. It turns audio, from short voice notes to recordings **longer than two hours**, into an evidence-backed intelligence report.

## 2. Approved technology baseline

| Concern | Technology |
|---|---|
| Frontend | React + TypeScript + Vite, Tailwind CSS + shadcn/ui (Radix UI base, ADR-0022), lucide-react (ADR-0024), Motion (ADR-0026), Three.js + React Three Fiber for the desktop 3D hero and pipeline explorer only (ADR-0027), IBM Plex fonts self-hosted (ADR-0028) |
| Backend API | Node.js + NestJS + TypeScript |
| AI orchestration | LangChain.js + LangGraph.js |
| Primary LLM | Anthropic Claude API (model per agent configurable, ADR-0013). **Conflict flagged:** a paid runtime API is not allowed by ADR-0034; production LLM inference is OD-47 (Open) |
| Speech-to-text | Configurable provider adapter (fake adapter first, ADR-0012) |
| Audio processing | Python + FFmpeg + librosa + NumPy, as a separate deterministic service (ADR-0002, ADR-0019). Phase 2B uses FFmpeg + NumPy only; librosa is deferred (not needed for the implemented measurements; deviation from this list pending the user's review) |
| Speaker diarization | pyannote.audio or managed provider, part of the transcription stage (benchmark before production, ADR-0012) |
| Database | PostgreSQL + pgvector (embeddings not used for now, ADR-0011) |
| Background processing | Redis + BullMQ, owned by Node/NestJS (ADR-0002) |
| Object storage | Local filesystem (dev), Amazon S3 (cloud) |
| Workspace tooling | pnpm + Turborepo, uv, Drizzle ORM (ADR-0005) |
| Testing | Vitest, Jest, Pytest, Playwright (with `@axe-core/playwright` for accessibility, ADR-0029) |
| Deployment | Docker Compose (local), AWS ECS + RDS + S3 (production). **Conflict flagged (2026-11-21):** paid cloud infrastructure is not allowed by ADR-0034; the production deployment target is OD-48 (Open) |

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
| OD-02a | STT for development and tests | Fake adapter (`STT_PROVIDER=fake`), kept after the production selection | Accepted | ADR-0012, ADR-0040 |
| OD-02b | STT production provider | Self-hosted Whisper small (whisper.cpp ggml q5_1, MIT) via pywhispercpp 1.5.1 in the audio service, decoded per Silero speech span with its own en/hi language; free, local, no network at runtime | Accepted (selection delegated by the user, 2026-11-24) | ADR-0036 |
| OD-03a | Diarization for development and tests | Fake adapter (`DIARIZATION_PROVIDER=fake`), kept after the production selection | Accepted | ADR-0012, ADR-0040 |
| OD-03b | Diarization production implementation, including the ADR-0016 thresholds and windowing algorithm | Self-hosted sherpa-onnx 2.0.2 with pyannote segmentation-3.0 (ONNX, MIT) + 3D-Speaker CAM++ (Apache-2.0) in the audio service; whole file up to 10 min, else 10 min windows / 30 s overlap with cross-window embedding matching (cosine ≥ 0.5); free, local | Accepted (selection delegated by the user, 2026-11-24) | ADR-0037 |
| OD-04a | Node ↔ Python integration | Node owns BullMQ/job lifecycle; Python service behind an internal API (confirmed by the Phase 2B prototype, reused for Phase 2C inference) | Accepted | ADR-0002, ADR-0040 |
| OD-04b | Orchestration | LangGraph orchestrates (not yet exercised; the Phase 2C coordinator stands in until the agent phase) | Accepted provisionally (agent phase) | ADR-0002, ADR-0040 |
| OD-05 | Research provider | Assistant suggestion: Claude server-side web search/fetch behind the ADR-0017 interface. **Conflict flagged:** this suggestion is a paid API and is not allowed by ADR-0034; the provider must be free and self-hostable | Open | — |
| OD-06 | Embeddings | Not used until a retrieval use case is demonstrated | Interim | ADR-0011 |
| OD-07 | Claude model per agent; cost | Configurable per agent; cost tracked per call and per run. **Conflict flagged:** assumes a paid Claude API, which ADR-0034 does not allow at runtime; to be resolved through OD-47 | Accepted | ADR-0013 |
| OD-08a | Tenancy | Workspace-based ownership and isolation | Accepted | ADR-0003 |
| OD-08b | Authentication provider | — | Open | — |
| OD-09a | Development data | Synthetic or explicitly consented audio only | Interim | ADR-0004 |
| OD-09b | Production privacy & data-handling policy, including retention and copyright handling of research source snapshots (ADR-0017) | Required before production | Open | — |
| OD-10 | Limits & targets (formats, size/duration, segment length/overlap, latency) | 4 h, 2 GiB, ≤ 8 ch, ≤ 192 kHz; audio service 768 MB / 2 CPUs, 2 inference threads (ADR-0041), anonymous-memory gate; windows 30 s / 1 s; media timeouts 120 s + 0.5 × duration, inference 120 s + 4 × audio; run deadline 1 h + 6 × duration; lossy timestamps ±10 ms | Accepted | ADR-0039, ADR-0041 |
| OD-11 | Tooling, ORM | pnpm, Turborepo, uv, Drizzle; verify pgvector compatibility before implementation | Accepted provisionally (verification) | ADR-0005 |
| OD-12 | Report formats & language | HTML in-app; PDF/DOCX exports; English default, Hindi option | Accepted | ADR-0006 |
| OD-13 | Hindi/Hinglish script | Preserve original script and code-switching; transliteration/translation are separate derived representations | Accepted | ADR-0007 |
| OD-14 | QA failure behaviour | Limited QA revision attempts, then human review (`needs_review`) | Proposed | — |
| OD-15 | Observability | Assistant suggestion: content-free structured logs; OpenTelemetry later | Open | — |
| OD-16 | Progress transport to client | SSE (with polling fallback) | Proposed | — |
| OD-17 | IaC and CI/CD | — | Open | — |
| OD-18 | Test audio corpus | Licence-checked list (Common Voice, FLEURS, LibriSpeech, MUCS 2021, MUSAN, DEMAND, consented internal); non-commercial sets excluded; download and real-speech benchmark are follow-up work | Accepted | ADR-0040 |
| OD-19 | Poor-quality audio | Continue where possible; report limitations | Accepted | ADR-0008 |
| OD-20 | Research privacy | Research mandatory; query minimisation and privacy controls | Accepted | ADR-0009 |
| OD-21 | Worker bounds | Required; numeric values set in configuration | Accepted | ADR-0010 |
| OD-22 | Transcript corrections | Versioned; never overwrite provider output; display names separate from machine IDs | Accepted | ADR-0007 |
| OD-23a | Python service framework | FastAPI + uvicorn, confined to the adapter; the service contract stays framework-independent (prototype confirmed) | Accepted | ADR-0023, ADR-0040 |
| OD-23b | Service-to-service authentication and networking, current development topology | Audio service on a normal bridge, published to `127.0.0.1:8001` only; bearer token (`AUDIO_SERVICE_TOKEN`) on all routes except liveness; container egress remains possible and is documented as such | Accepted | ADR-0035 |
| OD-23c | Service-to-service authentication, production / all-in-Compose | Network topology fixed by ADR-0035 (audio service on an `internal: true` network only, no published port); authentication mechanism (bearer token, mTLS or other) not decided; decided with OD-48 | Open | — |
| OD-24a | Storage of translations/transliterations | Original preserved; translation and transliteration stored separately | Accepted | ADR-0007 |
| OD-24b | How translations/transliterations are generated and triggered | — | Open | — |
| OD-25 | PDF/DOCX export library | Deferred to implementation by user decision | Open | — |
| OD-26a | Processing corrected transcripts | Must create traceable transcript versions and new processing runs | Accepted | ADR-0020 |
| OD-26b | Mechanism for corrected-transcript runs | New run with `sourceTranscriptVersionId`, starting at Context Intelligence (ADR-0020 §Proposed) | Proposed | ADR-0020 |
| OD-27 | Workspace roles, authorisation, database isolation (incl. RLS) | Must be defined before multi-user access is implemented | Open (blocks multi-user) | — |
| OD-28 | Cost ceiling behaviour | Stop further expensive processing; preserve completed results | Proposed | — |
| OD-29 | VAD implementation | Silero VAD v6.2.3 (MIT) through sherpa-onnx, splitting transcription windows into speech spans (threshold 0.4, silence 300 ms, speech 250 ms, padding 200 ms); preprocessing VAD stays `none` | Accepted | ADR-0038 |
| OD-30 | Claim verdict taxonomy | `supported`, `contradicted`, `partially_supported`, `unverifiable`, `not_checkable` | Proposed | — |
| OD-31 | SRS assumptions A-1 (batch only) and A-2 (three languages only) | As stated in SRS §2.3 | Proposed | — |
| OD-32 | Run A1 and A2 in parallel after preprocessing | Independent parallel branches; downstream agents wait for their required upstream results; A2/A3 may read A1's summary read-only without waiting (ADR-0046). Subject to graph-level validation | Accepted provisionally (graph validation) | ADR-0021 |
| OD-33 | Motion (`motion`) for UI animation | Approved, free features only (no Motion+); `LazyMotion` by default; reduced motion respected | Accepted | ADR-0026 |
| OD-34a | Three.js + React Three Fiber for 3D views | Approved for the desktop dashboard hero and an opt-in pipeline explorer only; lazy-loaded after first paint on capable desktops; mobile and reduced-motion users get the 2D SVG version; hero added in M2 using three.js without R3F (budget), pipeline explorer in M6b | Accepted | ADR-0027, ADR-0031 (timing), ADR-0032 (hero library) |
| OD-34b | Drei (React Three Fiber helpers) | Not approved; each helper needs separate approval | Open | — |
| OD-35 | Waveform / timeline rendering library | No candidate selected (a dependency-free canvas renderer is possible) | Open | — |
| OD-36 | Charting library | No candidate selected | Open | — |
| OD-37 | List/transcript virtualisation library | No candidate selected | Open | — |
| OD-38 | Fonts, including a Devanagari-capable face | IBM Plex Sans, IBM Plex Sans Devanagari and IBM Plex Mono, self-hosted WOFF2 limited to the weights and subsets used; no font service | Accepted | ADR-0028 |
| OD-39 | Server-side waveform peaks artefact and API endpoint | Deferred: decided when the waveform UI is built (precompute per preprocessing version, serve by time range); `level-series.json` is never served as peaks | Accepted (deferral) | ADR-0040 |
| OD-40 | shadcn/ui component base (primitive library) | Radix UI; scaffold with `shadcn init --base radix` because the CLI now defaults to Base UI | Accepted | ADR-0022 |
| OD-41 | Icon library | `lucide-react` (shadcn default) | Accepted | ADR-0024 |
| OD-42 | Run record at upload | Completing an upload creates a `pipeline_runs` row with the new status `created` (not yet submitted to the pipeline) | Accepted | ADR-0025 |
| OD-43 | Automated accessibility testing | `@axe-core/playwright` as an `apps/web` development-only dependency; no serious or critical violations | Accepted | ADR-0029 |
| OD-44 | Brand accents versus semantic colours | Brand accents and gradients only in app chrome, never in evidence surfaces; provenance, audio diagnostics and transcription uncertainty keep separate token families | Accepted | ADR-0030 |
| OD-45 | Recording playback access | Short-lived HMAC-signed playback URLs issued per workspace recording (audited); media route streams with HTTP Range; uniform 404; required signing secret. Production auth (OD-08b), authorisation (OD-27), rate limiting and S3 support outstanding | Accepted | ADR-0033 |
| OD-46 | Spending | Zero additional spending: no paid runtime AI APIs (including the Anthropic API), subscriptions, paid services, commercial or paid-tier dependencies, paid datasets or cloud spend. Claude Code / Pro for development assistance only. Prefer local open-source models, free Hugging Face resources and self-hosted projects, after licence, hardware (Apple M1, 8 GB unified memory, 512 GB SSD; corrected 2026-11-21 from Apple M2 16 GB, see ADR-0034 Amendment) and resource checks. Replacement providers are not selected | Accepted | ADR-0034 |
| OD-47 | Production LLM inference runtime (within ADR-0034) | No candidate selected; to be decided before the agent phase | Open | — |
| OD-48 | Production deployment target (within ADR-0034) | The approved AWS ECS + RDS + S3 target (HLD §2, SRS C-5, DEPLOYMENT_ARCHITECTURE) conflicts with ADR-0034's no-cloud-expenditure rule. Neither is changed; no replacement selected. S3 work under OD-45 depends on this | Open | — |
| OD-49 | Audio Quality Agent (A1) v1 method, overall classes and flag kinds | User decision 2026-11-26: deterministic rules over objective measurements, Silero VAD only as a speech/non-speech instrument; classes `good / acceptable_with_warnings / poor / insufficient` (changes the designed `good / degraded / poor`); added flag kinds; no ML quality model, no LLM; thresholds calibrated and approved separately | Accepted | ADR-0043 |
| OD-50 | A1 orchestration and placement in Phase 3A | User decision 2026-11-26: BullMQ for the 3A implementation inside the existing run coordinator, with framework-independent A1 node contracts; the shared LangGraph graph remains the platform target (OD-04b unchanged; prototype at Phase 3B); A1 runs on the `created` run before transcription is started; separate stage-node enum, `RUN_STAGES` unchanged; run completion stays defined by the transcription scope. Lifecycle deviations accepted 2026-11-26 (trigger sweep; wider A1-only retry; re-assessment after submission; ADR-0044 Amendment 2) | Accepted | ADR-0044 |
| OD-51 | Speech-aware objective measurements | User decision 2026-11-26: separate audio-service `measure` task (Silero in the sandboxed child, NumPy features) stored as preprocessing-scoped measurement sets; preprocessing unchanged; as built (amendment 2026-11-26): run by the preprocessing-side coordinator inside the A1 job, contract version unchanged | Accepted | ADR-0045 |
| OD-52 | A1 thresholds and Phase 3A numeric acceptance values | `a1-rules-1.0`: clipping high 0.05, speech-level medium −45 dBFS, other bands as built; hybrid SNR estimator (near-clean median switch at 45 dB); dropout low; P = R = 0.9, X = 90 % (no high flag on clean), Y = 2.0 dB, Z = 0.05. Synthetic-corpus targets only | Accepted | [ADR-0048](adr/0048-a1-thresholds-and-phase3a-acceptance-values.md) |
| OD-53 | Placement of Phase 3C (machinery and environmental sound intelligence) relative to SRS C-4 (exactly seven agents) | User decision 2026-11-26 (from the user's review): a distinct intelligence path sharing platform infrastructure, not inside A1 or A3; A1–A7 unchanged; SRS C-4 amended; agent vs capability and design decided in Phase 3C | Accepted | ADR-0047 |
| OD-54 | A1 output consumption by other agents | User decision 2026-11-26 (from the user's review): versioned `AudioQualitySummary` / `AudioQualityContext` as optional read-only metadata for A2, A3, A6, A7 via a reader port; no execution dependency for A2/A3, no behavioural coupling in Phase 3A, no automatic blocking/skipping; amends FR-3.5, ADR-0019, ADR-0021, AGENT §1–§4, TESTING §3 | Accepted | ADR-0046 |
| OD-55 | A1 SNR estimator bias at 20 dB (AC-8 follow-up) | Known limitation: MAE 3.05 dB, bias −2.91 dB at 20 dB against Y = 2.0 dB (M0 test split; met at 10 and 5 dB). Y is kept at 2.0 dB and AC-8 is accepted as partially met for Phase 3A (user decision 2026-11-26). Future work: correct the bias (for example a calibrated correction, or a better noise-power estimate), choose it on the dev split, then re-evaluate on test and on real speech (D-3A-13) | Open | [ADR-0048](adr/0048-a1-thresholds-and-phase3a-acceptance-values.md) |

Frontend dependencies OD-33 (ADR-0026), OD-34a (ADR-0027, amended by ADR-0031/0032) and OD-38 (ADR-0028) are approved within their ADRs' limits. OD-34b and OD-35 to OD-37 are **not** approved; each needs separate approval before installation.

**Design ADRs:**
- ADR-0015 preprocessing versions: Accepted
- ADR-0016 bounded-memory diarization: Accepted (principle; thresholds and algorithm in ADR-0037)
- ADR-0017 research adapter and evidence: Accepted (snapshot retention under OD-09b)
- ADR-0018 progress propagation: Accepted provisionally (prototype; transport OD-16)
- ADR-0021 parallel Audio Quality and Transcription: Accepted provisionally (graph validation)
- ADR-0025 run record at upload (`created` status): Accepted
- ADR-0014 run control (safe cancellation, bounded retries, one targeted research retry): Accepted
- ADR-0041 audio-service compute for inference (2 CPUs, 2 inference threads; memory, model and deadline unchanged): Accepted (user decision 2026-11-25; confirmed 2026-11-26). Known dense-speech limitation temporarily accepted
- ADR-0043 / ADR-0044 / ADR-0045 / ADR-0046 / ADR-0047 Phase 3A A1 method, orchestration, measure task, read-only A1 metadata for other agents, and the distinct Phase 3C path: **Accepted** (user decision 2026-11-26); amendments applied to SRS FR-3.5 / C-4, ADR-0019, ADR-0021, ADR-0025, AGENT_ARCHITECTURE, LLD, DATABASE_DESIGN, TESTING_STRATEGY
- ADR-0042 transcription and diarization accuracy thresholds (SRS NFR-3 / NFR-4): **Proposed** deferral, awaiting the user's decision; synthetic baseline preserved, no threshold set
