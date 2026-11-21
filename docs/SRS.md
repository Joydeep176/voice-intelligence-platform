# Software Requirements Specification (SRS)

Status: **Approved baseline plus requirements approved on 2026-11-19** (see [ARCHITECTURE_REVIEW](architecture/ARCHITECTURE_REVIEW.md) and ADR-0001 to ADR-0014). Values not yet fixed are **TBD** with a link to the [open decisions register](architecture/HLD.md#10-open-decisions-register). New requirements need explicit approval.

## 1. Introduction

### 1.1 Purpose
Defines what the AI Voice Intelligence Platform must do. Design lives in `docs/architecture/`.

### 1.2 Scope
A general-purpose platform that analyses voice audio in English, Hindi and Hinglish and produces an evidence-backed intelligence report. Ten workflow steps are carried out by seven product agents.

### 1.3 Definitions
| Term | Meaning |
|---|---|
| Workspace | The unit of data ownership and isolation |
| Recording | An uploaded audio file and its metadata |
| Run | One execution of the pipeline on a recording |
| Preprocessing version | Normalised audio, segments and diagnostics produced under one preprocessing configuration |
| Raw provider output | The unmodified response of an STT or diarization provider |
| Transcript version | An immutable transcript built from raw output (machine) or from a user correction |
| Derived representation | Transliteration, translation or normalisation of a transcript version |
| Audio diagnostics | Signal-level measurements of the audio (noise, clipping, distortion, dropouts, silence) |
| Transcription uncertainty | Model-level uncertainty in the transcript (low confidence, inaudible, overlapping speech, uncertain language or speaker) |
| Assertion | A single statement in the report |
| Provenance | `recorded` (said in the audio), `external` (from research evidence) or `inferred` (AI interpretation) |
| Evidence | A verbatim quotation from a retrieved and snapshotted source |

## 2. Overall description

### 2.1 Users
Users belong to workspaces. Authentication provider deferred (OD-08b). The workspace role model is OD-27.

### 2.2 Constraints
- C-1: Technology stack per [HLD §2](architecture/HLD.md#2-approved-technology-baseline).
- C-2: Anthropic Claude API is the primary LLM. **Conflict flagged (2026-11-21):** ADR-0034 does not allow a paid runtime AI API; production LLM inference is OD-47 (Open).
- C-3: STT and diarization go through provider adapters. Fake adapters until production providers are selected by benchmark (ADR-0012).
- C-4: Exactly seven product agents: Audio Quality, Transcription (including language identification and diarization), Context Intelligence, Research, Fact Validation, Reporting, QA (ADR-0001). Ingestion and preprocessing (decoding, normalisation, VAD, segmentation) are deterministic and are not agents (ADR-0019).
- C-5: Docker Compose locally; AWS ECS, RDS and S3 in production. **Conflict flagged (2026-11-21):** paid cloud infrastructure is not allowed by ADR-0034; the production deployment target is OD-48 (Open).
- C-6: Development uses only synthetic or explicitly consented audio (ADR-0004).

### 2.3 Assumptions (not yet confirmed: OD-31)
- A-1: Processing is batch (file-based). Live streaming is not in the baseline.
- A-2: Supported languages are English, Hindi and Hinglish only.

## 3. Functional requirements

### 3.1 Ingestion and validation (Step 1)
- FR-1.1: Users can upload audio from short voice notes to recordings longer than two hours.
- FR-1.2: Large uploads are multipart and resumable. A client can query which parts were received and continue an interrupted upload.
- FR-1.3: Files are validated (container/codec, duration, integrity) before processing and rejected with a clear reason. Limits: TBD (OD-10).
- FR-1.4: Original audio is stored unmodified in object storage.
- FR-1.5: Upload requires a consent attestation (SEC-1).

### 3.2 Preprocessing and segmentation (Step 2, deterministic audio-processing service)
- FR-2.1: Audio is decoded and converted to a canonical analysis format without modifying the original.
- FR-2.2: Voice activity detection (method: OD-29) informs segmentation. Long audio is split into overlapping segments. Length and overlap: TBD (OD-10).
- FR-2.5: Preprocessing is deterministic and makes no quality judgements.
- FR-2.3: All timestamps map to the original recording, in milliseconds.
- FR-2.4: Preprocessing outputs are versioned by configuration, so reprocessing never overwrites artefacts used by another run. Every preprocessing hash is stored with the full reproducible configuration and tool-version metadata it was computed from (ADR-0015).

### 3.3 Audio quality and distortion analysis (Step 3)
- FR-3.1: Objective audio measurements are computed per segment and per recording. The Audio Quality Agent analyses them and produces its own diagnostic output (for example noise, clipping, distortion, dropouts, silence, level).
- FR-3.2: Problem regions are flagged with timestamps, kind and severity.
- FR-3.3: Audio diagnostics are a separate data model from transcription uncertainty (FR-4.7) and are never inferred from transcript confidence.
- FR-3.4: Poor audio quality does not automatically stop processing. The pipeline continues where possible and the report states the limitations (ADR-0008). A run fails only when no usable audio can be decoded.
- FR-3.5: After preprocessing, audio quality analysis and transcription run independently (ADR-0021). Neither consumes or overwrites the other's output. Downstream stages start only when their required upstream results are complete.

### 3.4 Transcription and diarization (Steps 4 and 5)
- FR-4.1: Speech is transcribed with timestamps (word-level where available).
- FR-4.2: The Transcription Agent identifies language per segment (`en`, `hi`, `mixed`), with code-switch spans.
- FR-4.3: Original script and code-switching are preserved as produced (ADR-0007).
- FR-4.4: **Original STT and diarization provider output is stored immutably** and is never edited or overwritten.
- FR-4.5: Corrections, normalisation, transliteration and translation are stored as separate, versioned representations linked to their source.
- FR-4.6: Each transcript segment is attributed to a machine-generated speaker ID that is consistent across the whole recording, including recordings over two hours. Diarization uses bounded memory regardless of recording length (ADR-0016).
- FR-4.7: Transcription uncertainty (low confidence, inaudible speech, overlapping speech, uncertain language or speaker) is recorded as its own data model with timestamps.
- FR-4.8: STT and diarization providers are selected by configuration and adapter capability.

### 3.5 Context intelligence (Step 6)
- FR-6.1: Topics, entities, context and checkable claims are extracted from the transcript.
- FR-6.2: Each extracted item references transcript spans. Claims keep the verbatim quotation separate from any paraphrase.
- FR-6.3: Each item states its provenance (`recorded` for verbatim mentions, `inferred` for interpretation).

### 3.6 Deep internet research (Step 7)
- FR-7.1: Research is a mandatory workflow step, covering claims and relevant context (ADR-0009).
- FR-7.2: Research queries are minimised: no raw transcript excerpts, and no personal data unless it is needed to research the claim. All queries sent externally are recorded.
- FR-7.3: Source metadata is preserved: URL, title, publisher, publication date where available, retrieval time, content hash and a content snapshot.

### 3.7 Fact validation (Step 8)
- FR-8.1: Each claim receives a verdict with confidence, rationale and linked evidence. Taxonomy: OD-30 (*Proposed*).
- FR-8.2: A `supported` or `contradicted` verdict needs at least one evidence item quoted verbatim from retrieved source content. A search snippet alone is never sufficient.
- FR-8.3: Claims that cannot be resolved get **one** targeted research retry per run, then remain `unverifiable` (ADR-0014).

### 3.8 Reporting (Step 9)
- FR-9.1: The report brings together transcript, speakers, context, research, validation results and limitations.
- FR-9.2: **Every report assertion has provenance**: `recorded` with transcript span references, `external` with evidence references, or `inferred` with its basis (referenced assertions) and confidence. A statement that mixes provenance types is split.
- FR-9.3: Audio signal diagnostics and transcription uncertainty appear in **separate report sections**.
- FR-9.4: The primary report is HTML in the app, with PDF and DOCX exports. The default language is English; Hindi is optional (ADR-0006).
- FR-9.5: The report records which transcript version it was generated from.

### 3.9 Quality assurance (Step 10)
- FR-10.1: The QA agent is independent and read-only. It writes only QA results.
- FR-10.2: QA checks citations, provenance completeness and correctness, evidence sufficiency, contradictions with verdicts, required sections, and separation of diagnostics from uncertainty.
- FR-10.3: Behaviour on QA failure: TBD (OD-14).

### 3.10 Run management
- FR-11.1: Users can see per-stage status and progress, propagated from all workers including the audio service (ADR-0018).
- FR-11.2: Users can cancel a run. Cancellation is safe: no new work starts, in-flight tasks are cancelled or allowed to finish and are discarded, and completed artefacts stay consistent.
- FR-11.3: Failed or cancelled runs can be retried from the last checkpoint, up to a configured maximum number of retries.
- FR-11.4: Users can view the transcript (any version), speakers, diagnostics, uncertainty, claims, sources and report.

### 3.11 Transcript corrections
- FR-12.1: Users can submit transcript corrections, which create a new transcript version. Provider output and earlier versions are never overwritten.
- FR-12.2: Users can edit speaker display names. Machine speaker IDs never change.
- FR-12.3: Corrections and display-name changes are audited.
- FR-12.4: Processing a corrected transcript creates a new, traceable run linked to the source transcript version and the parent run. Earlier runs and their outputs are never modified (ADR-0020).

### 3.12 Security, privacy and data handling
- SEC-1 **Consent**: every upload records a consent attestation (who, when, statement version). Production consent wording and legal basis: OD-09b.
- SEC-2 **Workspace isolation**: every data item belongs to exactly one workspace. Cross-workspace access is impossible through any API.
- SEC-3 **Access control**: all endpoints except health checks need an authenticated principal with workspace membership. Workspace roles, authorisation rules and database isolation must be defined before multi-user access is implemented (OD-27).
- SEC-4 **Encryption**: data encrypted at rest (database, object storage, queue store) and in transit (TLS for all network hops).
- SEC-5 **Retention**: retention periods configurable per workspace. Defaults set before production (OD-09b).
- SEC-6 **Deletion**: deleting a recording removes all derived data: DB rows, storage objects (all versions), checkpoints, queued jobs and exports. Backup and vendor-side handling are defined before production.
- SEC-7 **External data sharing**: every outbound data flow (Claude, STT, diarization, research, observability) is inventoried. Only the minimum necessary data is sent. Vendor retention settings are documented before production.
- SEC-8 **Auditability**: security-relevant actions (access to recordings, transcripts and reports, uploads, deletions, corrections, exports, configuration changes) are recorded in an append-only audit log that contains no content.
- SEC-9 **Secrets and content hygiene**: secrets, raw audio and transcript text never appear in logs, traces, error messages or source control.
- SEC-10 **Untrusted media**: media parsing runs in an isolated, resource-limited service with size, duration and time limits.

### 3.13 Bounded processing
- OPS-1: Every queue and worker pool has a configured concurrency limit.
- OPS-2: Every job and audio-service task has a timeout.
- OPS-3: Automatic retries are bounded, with exponential backoff, and apply only to retryable errors.
- OPS-4: Stuck (stalled) jobs are detected and recovered or failed within a bounded time. Permanently failed jobs are retained for inspection.
- OPS-5: Each run has a cap on parallel jobs.
- OPS-6: Each run has a cost ceiling. LLM and provider usage is tracked per call and per run (ADR-0013). Behaviour when the ceiling is reached: OD-28.
- OPS-7: All loops (QA revision, research retry) have hard caps.

## 4. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Recordings > 2 h end-to-end | Required. Maximum duration TBD (OD-10) |
| NFR-2 | Latency / throughput | TBD (OD-10) |
| NFR-3 | Transcription accuracy (WER/CER per language) | TBD, from benchmark (ADR-0012) |
| NFR-4 | Diarization accuracy (DER) | TBD, from benchmark |
| NFR-5 | No completed stage is lost on a worker crash | Required |
| NFR-6 | Replacing a provider needs no domain-code changes | Required |
| NFR-7 | Bounded memory in audio processing and diarization for arbitrarily long recordings | Required. Thresholds and algorithm from benchmark (OD-03b) |
| NFR-8 | Observability of runs and LLM calls without content leakage | Required. Tooling OD-15 |
| NFR-9 | Security and privacy | §3.12 |

## 5. Traceability

Cite requirement IDs (FR, SEC, OPS, NFR) in ADRs, tests and pull requests.
