# Architecture Review: Documentation Baseline v0

- Date: 2026-11-19
- Scope: `CLAUDE.md`, `docs/SRS.md`, `docs/architecture/*.md`, `docs/templates/ADR_TEMPLATE.md`, `.claude/{agents,rules,skills}/**`
- Type: documentation-only review. No architecture documents were changed. No open decision is resolved here: every "Recommendation" is a proposal awaiting approval.
- Reviewer note: the documents under review were written by the same assistant doing this review. To offset that, findings are stated against the literal text of the approved baseline, and anything the docs added is called out explicitly.

> **Resolution status (2026-11-19, revised).** The user approved decisions and corrections on 2026-11-19 in two rounds. They are applied in the current documents and recorded in ADR-0001 to ADR-0021. The authoritative status of every decision is HLD §10; this table only maps review findings to their outcome. This review is kept as a historical record: section references below point to the *pre-correction* documents, and agent names reflect the earlier proposal (for example "Speech Agent" is now the Transcription Agent, "Audio Analysis Agent (steps 2–3)" is now a deterministic preprocessing stage plus the Audio Quality Agent (step 3, ADR-0019), "Fact Verification" is now Fact Validation, and "Report" is now Reporting).
>
> | Findings | Resolution |
> |---|---|
> | §2.2 criteria; M-01 to M-11 | Added to SRS as FR-4.4–4.7, FR-7.2–7.3, FR-8.2, FR-9.2–9.3, SEC-1–10, OPS-1–7 |
> | X-01 unusable-audio stop | Removed. Processing continues (ADR-0008) |
> | X-02 optional research | Removed. Research is mandatory with privacy controls (ADR-0009) |
> | X-03 FR-11.x, X-04 research loop | Approved: cancel/retry and one targeted research retry (ADR-0014) |
> | X-06 display names | Approved, separate from machine IDs (ADR-0007) |
> | X-05 verdict taxonomy, X-07 assumptions | Proposed (OD-30, OD-31) |
> | I-01 context claim | Corrected (HLD §7) |
> | I-02 asset ownership | Preprocessing versions with stored config and tool-version metadata (ADR-0015, Accepted) |
> | I-03/I-04 progress | ADR-0018 (Accepted provisionally); event names aligned with statuses |
> | I-05 test runners | Vitest for `packages/*`, Jest for NestJS apps; rules aligned |
> | I-06 STT queue routing | Self-hosted models reached via the audio-service client (LLD §2.2, §5) |
> | I-07 diarization memory | ADR-0016 (Accepted principle; thresholds/algorithm by benchmark) |
> | I-08 research adapter | ADR-0017 (Accepted) |
> | I-09 VAD | VAD belongs to the deterministic audio service (ADR-0019). Implementation method Open (OD-29); WebRTC VAD and Silero VAD approved for benchmarking |
> | I-10/I-11 API gaps | Topics, entities, upload-session resume added (API §2, §6) |
> | I-12 embeddings key | Moot while embeddings are not used (ADR-0011, Interim) |
> | I-13 validation split | Documented (HLD §5, LLD §2) |
> | I-14 FR-3.3 conflation | Rewritten (SRS FR-3.3) |
> | I-15 idempotency keys | DATABASE §1 |
> | I-16 checkpoints in deletion scope | DATABASE §6 |
> | Round-1 verification error | The round-1 summary said "no resolved OD remains Open/TBD" but checked only fully resolved IDs, while partly resolved IDs (OD-02/03/08/09/11) had mixed statuses. Fixed by splitting rows (a/b) with one status each (HLD §10) |
> | C-01 to C-12 | CLAUDE.md working rules, read-only agents (Read/Grep/Glob), tooling-neutral → Drizzle-aligned rules, `.gitignore`, `verify-change` skill. C-07: `.claude/settings.json` permission deny rules added in round 2 (authorised) |

---

## 1. Executive assessment

**Overall: not yet ready for implementation approval.** The documentation set is structurally sound: async-first, provider adapters, durable runs, evidence-linked outputs. It also follows the approved technology baseline faithfully. Three problems need fixing first:

1. **Several review criteria are not captured as requirements.** Transcript preservation, separation of recorded facts / external research / AI interpretation, audio diagnostics vs transcription uncertainty, and security/consent/privacy/deletion are absent or only implied. Some of these were **never in the approved baseline text** I received (see §2.2). They need your confirmation before they are added to the SRS as requirements.
2. **Some requirements and behaviours were introduced without approval.** Examples: stopping a run on unusable audio (FR-3.4), making research optional per run, run cancel/retry requirements (FR-11.x), and a research→verification loop. They are reasonable, but they are additions.
3. **There are cross-document inconsistencies that would produce defects in code.** Examples: audio segments scoped to the recording while being produced per run, conflicting test-runner rules for `packages/contracts`, a research adapter interface that cannot represent server-side search tools, and no event channel from orchestrator to API for progress streaming.

Seven decisions block initial implementation: OD-01, OD-04, OD-11, a minimal OD-08 (tenancy shape), a minimal OD-09 (data-handling rules for development), OD-12 (provenance model) and OD-13 (transcript layering). Recommendations are in §5 and blockers in §6.

Severity scale used below: **P0** = must fix before implementation; **P1** = fix before the affected component is built; **P2** = improvement.

---

## 2. Approved baseline compliance

### 2.1 Approved baseline items

| Baseline item | Status | Notes |
|---|---|---|
| Technology stack (all 13 rows) | ✅ Compliant | HLD §2 reproduces the stack verbatim. Proposals (ElastiCache, CDN, Jest-for-Nest split) are labelled. |
| 10-step workflow | ✅ Compliant | HLD §3, SRS §3.1–3.10. |
| Seven specialised agents via LangGraph | ⚠️ Compliant in count. Mapping unapproved (OD-01) | See §3.2. Transcription (step 4) and diarization (step 5) share one agent. |
| English, Hindi, Hinglish | ⚠️ Partially specified | Language is tagged per segment (`en/hi/mixed`). Word-level code-switch spans, script policy (OD-13) and evaluation of LLM stages on Hindi/Hinglish input are missing. |
| Short notes to >2 h recordings | ⚠️ Mostly compliant | Chunking, multipart upload and paged transcript API are present. Two memory/accuracy issues remain (§4.3). The HLD also wrongly states a 2 h transcript cannot fit in one prompt (§4.1, I-01). |
| Local storage (dev) / S3 (cloud) | ✅ Compliant | `StorageService` with two implementations. |
| Docker Compose / ECS + RDS + S3 | ✅ Compliant | |
| Vitest, Jest, Pytest, Playwright | ⚠️ Inconsistent allocation | See I-05. |
| "Do not create fake implementation files / claim integrations exist" | ✅ Compliant | No code; CLAUDE.md states documentation-only status. |

### 2.2 Review criteria vs. the baseline text

Several criteria in this review request **do not appear in the approved baseline text** I was given. Where they came from "original product requirements", those requirements were not part of my input. They are assessed below and **should be added to the SRS only with your confirmation**.

| Criterion | In approved baseline text? | Current documentation | Gap severity |
|---|---|---|---|
| Seven distinct agent responsibilities | Yes (count only) | Defined, but A1 and A2 each cover two steps | P0 (confirm OD-01) |
| Audio Quality Analysis separate from Transcription | Implied (steps 3 and 4 are distinct) | ✅ Separate agents (A1 vs A2) | — |
| Preservation of the original transcript | **No** | ❌ Not addressed. Only a stitched/aligned transcript is stored. Raw provider output is not kept. No immutability rule. Script conversion (OD-13) could overwrite original text | P0 |
| Separation of recorded facts, external research and AI interpretation | **No** (partly implied by steps 6–8) | ❌ Report schema undefined (OD-12). No statement-level provenance type. `topics/entities.summary` mix AI interpretation into context tables without labelling | P0 |
| Audio diagnostics vs transcription uncertainty | **No** | ❌ Both exist implicitly (`quality_metrics` vs `transcript_segments.confidence`), but the docs never say they are different signals. FR-3.3 even blurs them ("confidence caveat"). No markers for inaudible/overlapping speech or uncertain language ID | P0 |
| Evidence-backed research and claim verification | Implied (steps 7, 8) | ⚠️ Partial. `claim_evidence` and source provenance exist. Missing: source snapshotting for reproducibility, source independence/credibility, the minimum evidence a `supported` verdict needs, and a rule that a verdict without linked evidence is invalid | P1 |
| Resumable processing, bounded workers, checkpointing | **No** (Redis + BullMQ implies background jobs) | ⚠️ Checkpointing and resume designed. "Bounded workers" only partial: no job timeouts, stalled-job policy, dead-letter queue, per-run fan-out cap or per-run budget enforcement point | P1 |
| Security, consent, privacy, deletion | **No** | ❌ Deferred wholesale to OD-08/OD-09. No consent capture, audit log, encryption at rest for RDS, third-party data flow inventory, or complete deletion scope (checkpoints, Redis, logs, traces, backups, vendor copies) | P0 (minimum policy) |

### 2.3 Introduced without approval

| ID | Introduced item | Location | Recommendation |
|---|---|---|---|
| X-01 | Run stops on unusable audio (`failed_quality`) | SRS FR-3.4, AGENT §2 | **Possible weakening**: it may block transcripts users still want. Make it a decision: stop, or continue with caveats (new OD-19). |
| X-02 | Research optional per run (`researchEnabled`) and skipped when no checkable claims | API §3, AGENT §2 | Step 7 is mandatory in the baseline. An opt-out may still be needed for privacy (see §4.6). Make it a decision (OD-20). |
| X-03 | FR-11.1–11.4 (progress, retry, cancel, view) | SRS §3.11 | Likely wanted, but not in the baseline. Confirm. |
| X-04 | Verification → Research follow-up loop | AGENT §2 | Confirm, or remove for v1. |
| X-05 | Verdict taxonomy (5 values) | AGENT §4 A5, DB | Proposed; confirm. |
| X-06 | Speaker `display_name` (user-editable) | DB §3 | Remove until approved. It also touches transcript preservation. |
| X-07 | Assumptions A-1 (batch only) and A-2 (three languages only) | SRS §2.4 | Reasonable reading of the baseline; confirm. |
| X-08 | Configurable report output language | HLD §8 | Fold into OD-12. |
| X-09 | `apps/orchestrator` split and `packages/contracts` | LLD §1 | Proposed structure; confirm with OD-11. |
| X-10 | ADR template file | `docs/templates/` | Supporting artefact, not a requirement. Low risk. |

---

## 3. Deviations and missing requirements

### 3.1 Missing requirements (proposed additions; need approval)

| ID | Proposed requirement | Rationale |
|---|---|---|
| M-01 | **Layered, immutable transcript.** (a) Raw provider output per segment stored verbatim and never modified. (b) Canonical stitched + diarized transcript, versioned. (c) Derived views (transliteration, normalisation) stored separately. Every layer is traceable to the one beneath it. | Transcript preservation; reproducibility; OD-13 safety |
| M-02 | **Statement provenance classes** in the report and all LLM outputs: `recorded` (what was said, quoted with span/speaker), `external` (finding from cited source), `inferred` (AI interpretation, with basis and confidence). Statements without a valid provenance fail QA. | Fact/research/interpretation separation |
| M-03 | **Two separate uncertainty channels.** *Audio diagnostics* (signal-level: noise, clipping, dropouts, distortion, from A1) and *transcription uncertainty* (model-level: low word/segment confidence, inaudible markers, overlapping speech, language-ID uncertainty, from A2). Stored, exposed and reported separately. Neither is inferred from the other. | Diagnostics vs uncertainty |
| M-04 | **Evidence rules**: every verdict except `not_checkable` links ≥1 evidence item. `supported`/`contradicted` need source excerpts. Source content is snapshotted (hash + stored text or excerpt) at retrieval time. Source independence is recorded. | Evidence-backed verification |
| M-05 | **Worker bounds**: per-queue concurrency, per-job timeout, stalled-job handling, max attempts, dead-letter queue, per-run fan-out ceiling, per-run token/cost ceiling enforced in the LLM factory. | Bounded workers |
| M-06 | **Consent**: the uploader attests to having consent of recorded parties (wording/legal basis per OD-09). Attestation is stored with the recording. | Consent |
| M-07 | **Third-party data flow inventory**: which data goes to Claude, STT, diarization, research and tracing providers; vendor retention settings; a per-run option to block external research (privacy). | Privacy |
| M-08 | **Complete deletion**: deleting a recording removes DB rows, storage objects (all versions), LangGraph checkpoints, Redis job payloads, embeddings, and trace/log content keyed by the run. Defined handling for backups and vendor-side copies. | Deletion |
| M-09 | **Audit log** of access, deletion and run actions. | Security |
| M-10 | **Encryption** at rest (RDS, S3, Redis) and in transit (TLS between services and to Redis). | Security |
| M-11 | **Untrusted media handling**: FFmpeg/ffprobe run in a sandboxed, resource-limited worker. Decoded-size, duration and timeout limits. | Security (parser attack surface) |

### 3.2 Agent responsibilities and boundaries

| Agent | Boundary quality | Issue |
|---|---|---|
| A1 Audio Analysis (steps 2, 3) | ⚠️ | Unclear whether it uses an LLM at all ("LLM/rule interpretation"). Recommend rule-based only for v1, because LLM interpretation of DSP metrics adds cost without clear value. Must output **audio diagnostics only** (M-03). |
| A2 Speech (steps 4, 5) | ⚠️ | Combines two baseline steps. Owns transcription uncertainty. Must write the raw layer (M-01). Diarization-whole-file vs memory rule conflict (I-07). |
| A3 Context Intelligence | ⚠️ | Outputs mix `recorded` and `inferred` content without labels (M-02). Claim extraction must quote spans, not paraphrase only. |
| A4 Research | ⚠️ | Adapter interface fits client-side search only (I-08). Research queries may leak recording content (§4.6). |
| A5 Fact Verification | ✅/⚠️ | Clear role; needs M-04 evidence rules. |
| A6 Report | ⚠️ | Schema undefined (OD-12). Needs M-02 provenance and both uncertainty channels in caveats. |
| A7 QA | ✅ | Independent and read-only. Should also verify provenance classes and the two-channel caveats. |

**Alternative mappings.** To keep transcription and diarization as separate agents, two other steps must be merged into one agent. Merging Report and QA removes independent review, and merging Research and Verification collapses the evidence boundary, so both are rejected. The only viable alternative merges Context Intelligence with Report, which weakens report focus. **Conclusion:** the current mapping (Speech = transcription + diarization) is recommended. It still needs approval (OD-01).

---

## 4. Cross-document inconsistencies

| ID | Sev | Inconsistency | Location | Correction |
|---|---|---|---|---|
| I-01 | P1 | "Transcript is too large for one prompt" is overstated. A 2 h English transcript is roughly tens of thousands of tokens and fits current Claude context windows. Hindi in Devanagari tokenises less efficiently but is likely to fit too. The real constraints are cost, latency and attention quality, not hard limits. | HLD §7 (line 117) | Reword: the strategy (full-context vs hierarchical vs retrieval) is chosen per agent from budget (OD-07). This weakens the case for pgvector (OD-06). |
| I-02 | P0 | `audio_segments` and `quality_metrics` are scoped to `recording_id`, yet A1 runs inside every run, and chunking parameters can change between runs. Re-runs would overwrite or conflict. | DB §2–3, AGENT A1, API `/runs/{id}/quality` | Scope them to the run, or to a `preprocessing_version` keyed by config hash. |
| I-03 | P1 | No event channel from orchestrator to API for progress streaming. | LLD §2, API §3, OD-16 | Add one (e.g. Redis pub/sub or BullMQ QueueEvents) to the LLD. |
| I-04 | P1 | Run statuses (`failed_quality`, `needs_review`, `cancelled`) have no matching progress events (only `run.completed`/`run.failed`). | API §3 vs DB §3 | Align the event names with the status enum. |
| I-05 | P0 | `packages/contracts` tested with Vitest per the testing strategy, but `backend-nestjs` rule (paths include `packages/contracts/**`) says Jest. | TESTING §1 line 9; `.claude/rules/backend-nestjs.md` line 16 | Pick one; remove `packages/contracts` from that rule or split the rule. |
| I-06 | P1 | `stt.segment` is consumed by the orchestrator, but the provider skill says self-hosted models run in `services/audio`. A self-hosted STT path has no queue. | LLD §5 line 119; `add-provider-adapter` skill | Route by provider: the queue consumer depends on adapter type. |
| I-07 | P1 | LLD/AGENT: diarize the "whole normalised file". python-audio rule: "never load a full 2h+ recording into memory". pyannote loads the waveform (~0.46 GB float32 for 2 h at 16 kHz mono; more for longer files) and memory/GPU use grows with duration. | LLD §4.7 line 110; rule line 9 | Pick one: allow a documented, bounded exception for diarization, or require chunked diarization with cross-chunk embedding clustering. Set the maximum duration (OD-10) accordingly. |
| I-08 | P1 | The `ResearchProvider` interface (`search`/`fetch`) cannot represent Claude's server-side web search tool, where search happens inside the model call. Yet that tool is a listed OD-05 candidate. | LLD §3 line 95; HLD OD-05 | Make the interface operate at the "research a question → findings + citations" level, or provide two adapter shapes. |
| I-09 | P1 | "VAD/silence-aware segmentation". A neural VAD (e.g. Silero, WebRTC VAD) would be a dependency outside the approved stack. librosa provides only energy-based splitting. | HLD §7 line 114; LLD §2.3 | State energy-based (librosa) for v1; any VAD model needs approval. |
| I-10 | P1 | Topics, entities and context outputs (FR-6.1) have tables but no API endpoints. | API §4 vs DB §3 | Add read endpoints, or state they are exposed only inside the report. |
| I-11 | P1 | FR-1.2 says "resumable" uploads, but the API has no endpoint to list already-uploaded parts or to resume a session. | SRS FR-1.2; API §2 | Add a `GET` for the upload session (parts received). |
| I-12 | P2 | `segment_embeddings` references "transcript segment or window ID": ambiguous key. | DB §3 | Decide with OD-06. |
| I-13 | P2 | Ingestion validation is split (API shallow checks; worker ffprobe deep checks), but HLD §5 lists "validation" under `api` only. | HLD §5; LLD §2.3 | State the two-stage validation explicitly. |
| I-14 | P2 | FR-3.3 conflates the audio quality signal with transcription "confidence". | SRS line 59 | Rewrite per M-03. |
| I-15 | P2 | DB has no idempotency constraints that back the "nodes are idempotent" rule (e.g. unique (`run_id`, `attempt`) on stage outputs; claims have no natural key). | DB §3; AGENT §2 | Add unique keys per node output. |
| I-16 | P2 | LangGraph checkpoints store state "summaries". Summaries of transcripts are personal data, so checkpoints fall within deletion and retention scope. Not stated. | AGENT §3; DB §5 | Covered by M-08. |

### 4.1 Database support for the workflow
Steps 1–10 all have entities. Gaps: raw transcript layer (M-01), provenance on report statements (M-02), transcription-uncertainty markers (M-03), source snapshots (M-04), consent attestation (M-06), audit log (M-09), run-scoped preprocessing (I-02), idempotency keys (I-15).

### 4.2 API support for product features
Upload, run lifecycle, transcript, claims, sources, report and QA are covered. Gaps: I-10, I-11, I-04, consent attestation on upload (M-06), raw vs canonical transcript layers (M-01), a separate audio diagnostics endpoint vs transcription uncertainty (M-03, partly `/quality`).

### 4.3 Long recordings without full in-memory loads
- Upload: ✅ multipart/chunked.
- Normalisation: ✅ FFmpeg streams.
- Quality analysis: ⚠️ must use block-wise processing (e.g. `librosa.stream` or soundfile block reads), not a full `librosa.load`. Not stated in the LLD.
- Diarization: ❌ conflict (I-07).
- Transcript retrieval/UI: ✅ time-range paging.
- LLM stages: ✅ by reference. See I-01 on the rationale.
- Report JSON in one `jsonb` column: ⚠️ acceptable, but bound the size.

### 4.4 Provider replaceability
Adapters exist for STT, diarization, research, LLM, embeddings and storage. Weak points: I-08 (research interface shape), the LLM factory abstraction coupled to LangChain's Anthropic integration (acceptable, since Claude is the mandated primary LLM), and `transcripts.stt_provider` recording only one provider when segments may fall back to another.

### 4.5 Security and privacy across the architecture
Only partially reflected: S3 SSE, private subnets, secrets manager and prompt-injection separation are present. Missing items are M-06 to M-11, plus the research privacy risk below.

### 4.6 Privacy risk in external research (new, P0)
Research queries derived from private recordings are sent to a third-party search provider (or through Claude's web search). This is an outbound flow of potentially sensitive content. It needs a policy (OD-09), query minimisation (no names or PII unless the claim requires them), and a per-run control (OD-20).

---

## 5. Open-decision recommendations

None of these are approved. "Blocks" = blocks initial implementation (repo scaffolding plus the first vertical slice: upload → preprocess → transcribe → view).

### OD-01: Step-to-agent mapping
- **Decide:** which agent owns which of the 10 steps.
- **Why:** sets module boundaries, graph shape and state contracts.
- **Options:** (a) current: Speech = transcription + diarization; (b) separate Transcription and Diarization agents, merging Context and Report; (c) separate Transcription and Diarization agents, merging Research and Verification.
- **Pros/cons:** (a) matches provider reality (combined STT+diarization APIs) and keeps evidence and QA boundaries, but one agent spans two steps. (b) gives one agent per audio step, but weakens report focus. (c) collapses the evidence boundary.
- **Cost/ops:** negligible difference.
- **Recommendation:** (a).
- **Blocks:** **Yes.**

### OD-02: STT provider(s) and Hinglish handling
- **Decide:** first provider(s), routing, and how code-switching is represented.
- **Why:** largest driver of transcript accuracy and per-minute cost.
- **Options:** managed global (e.g. AssemblyAI, Deepgram, Google, Azure, AWS Transcribe), India-focused (e.g. Sarvam AI), self-hosted Whisper-family (e.g. faster-whisper).
- **Pros/cons:** managed services are fast to integrate, scale and often include diarization, but cost per minute and send audio to a vendor. India-focused providers are potentially stronger on Hindi/Hinglish, but are a less proven vendor-scale bet. Self-hosted keeps data in-house with no per-minute fee, but needs GPU operations and usually has weaker Hinglish accuracy without fine-tuning.
- **Cost/ops:** managed is opex per audio minute. Self-hosted means GPU instances (ECS on EC2) plus model operations. Capabilities and prices must be verified at decision time; none are asserted here.
- **Recommendation:** build the adapter and a fake provider first. Benchmark 3 candidates (one global managed, one India-focused, one self-hosted Whisper baseline) on an en/hi/Hinglish set (needs OD-18), then pick a primary and a fallback.
- **Blocks:** no for scaffolding; **yes** for the first real transcription.

### OD-03: Diarization: pyannote self-hosted vs managed
- **Decide:** implementation and where it runs.
- **Why:** speaker consistency over >2 h; GPU cost; data residency.
- **Options:** (a) pyannote.audio self-hosted (gated model weights, needs licence acceptance); (b) the managed pyannote service or another managed provider; (c) diarization built into the chosen STT provider.
- **Pros/cons:** (a) gives control, no per-minute fee and data stays in-house, but needs a GPU for practical speed on long audio, runs into the memory issue in I-07, and adds model operations. (b) is simple, but is an extra vendor and data flow. (c) means one call and lowest integration cost, but couples diarization quality to the STT choice.
- **Cost/ops:** (a) needs ECS EC2 GPU capacity (Fargate has no GPU). (b)/(c) are per-minute fees.
- **Recommendation:** start with (c) if the OD-02 winner offers it. Keep (a) as the benchmarked alternative. Decide on DER results.
- **Blocks:** no (the Speech agent can ship transcription first).

### OD-04: Node ↔ Python integration and long-job waiting
- **Decide:** transport, and how the graph waits on long jobs.
- **Why:** reliability of runs over 2 h; bounded workers.
- **Options:** transport: (a) Python BullMQ client, (b) internal HTTP service, (c) gRPC. Waiting: (i) block inside the job, (ii) LangGraph pause and resume on job completion, (iii) BullMQ flows (parent/child) for fan-out/fan-in, then resume the graph.
- **Pros/cons:** (a) uses one queue system, but the Python BullMQ client has less feature parity than Node's. (b) is simple, but synchronous HTTP is poor for long jobs. (i) is simplest, but ties up workers for hours. (ii)+(iii) are robust and bounded, but more complex.
- **Cost/ops:** (a) adds no new infrastructure. (b) adds a service to deploy.
- **Recommendation:** (a) + (iii) for segment fan-out + (ii) for graph resumption. Spike the Python BullMQ client first.
- **Blocks:** **Yes** (pipeline skeleton).

### OD-05: Research provider
- **Decide:** search/fetch mechanism.
- **Why:** evidence quality, cost, privacy.
- **Options:** Claude server-side web search (and fetch) tools; third-party search APIs (e.g. Tavily, Exa, Brave Search).
- **Pros/cons:** Claude tools mean no extra vendor and built-in citations, but less control over sources and the interface mismatch in I-08. Third-party APIs give more control and caching, but are another vendor and need the client-side tool loop.
- **Cost/ops:** both bill per search, plus tokens.
- **Recommendation:** fix I-08 first, then start with Claude's web search tool, with domain allow/deny lists and query minimisation (§4.6).
- **Blocks:** no.

### OD-06: Embeddings and pgvector scope
- **Decide:** whether retrieval is needed in v1; model and dimension.
- **Why:** an extra vendor and data flow; schema dimension.
- **Options:** managed multilingual (e.g. Voyage, Cohere, OpenAI); self-hosted multilingual (e.g. bge-m3, multilingual-e5); defer.
- **Pros/cons:** given I-01, full-context or hierarchical summarisation may be enough for v1. Retrieval helps cost on very long audio. Hindi quality varies by model.
- **Cost/ops:** managed is per token. Self-hosted needs CPU/GPU inference.
- **Recommendation:** **defer.** Keep pgvector enabled but add the embeddings table in a later migration, once an eval shows retrieval is needed.
- **Blocks:** no.

### OD-07: Claude model per agent and budgets
- **Decide:** model tier per agent; per-run token/cost ceilings.
- **Why:** cost scales with recording length.
- **Options:** single model everywhere; tiered models.
- **Pros/cons:** single is simple but costly. Tiered is cheaper but needs evals per agent.
- **Cost/ops:** config only.
- **Recommendation:** tiered and config-driven. Strongest model for Verification, Report and QA; mid-tier for Context and Research; small model for classification sub-tasks. Enforce a per-run ceiling in the LLM factory (M-05).
- **Blocks:** no.

### OD-08: Authentication, authorisation, tenancy
- **Decide:** identity provider; single-user vs multi-tenant (workspaces).
- **Why:** schema shape (`workspace_id` on every table), API guards, data isolation.
- **Options:** Amazon Cognito; Auth0/Clerk; self-managed JWT (Passport); no auth for local dev only.
- **Pros/cons:** Cognito is AWS-native and cheap, but has rougher developer experience. Auth0/Clerk have good developer experience but are an extra vendor with per-MAU pricing. Self-managed gives full control but carries security burden.
- **Cost/ops:** Cognito is lowest at small scale.
- **Recommendation:** decide the **tenancy shape now** (workspace-scoped rows, recommended). Defer the identity provider choice, with Cognito as the default candidate.
- **Blocks:** **tenancy shape yes**; IdP no.

### OD-09: Retention, PII, consent, residency, vendor processing
- **Decide:** retention periods, consent model, redaction, residency, vendor data agreements.
- **Why:** voice recordings of third parties are sensitive personal data. Laws may apply depending on users' jurisdictions (e.g. India's DPDP Act 2023 for Indian data principals). This is not legal advice; it needs legal review.
- **Options:** per-item policy choices (configurable retention, hard vs soft delete, consent attestation vs explicit per-speaker consent, region pinning).
- **Cost/ops:** region pinning restricts vendor choice (OD-02/03/05).
- **Recommendation:** adopt an interim **development policy** now: synthetic or consented test audio only; no production data; hard delete; vendor zero/limited-retention settings where available. Make the full decision before any real user data.
- **Blocks:** **interim policy yes**; full policy blocks production only.

### OD-10: Limits and targets
- **Decide:** formats, max size/duration, chunk length/overlap, latency/throughput.
- **Why:** sizing, memory (I-07), UX expectations.
- **Options:** fixed global limits, or limits per STT provider.
- **Recommendation:** chunk length/overlap per provider in config. Set an initial max duration that is explicitly tested (e.g. a soak test well above 2 h). Leave latency targets TBD until benchmarks exist.
- **Blocks:** partial (segmentation defaults).

### OD-11: Monorepo tooling and ORM
- **Decide:** JS package manager/task runner, Python environment manager, ORM/migrations.
- **Why:** shapes every command in CLAUDE.md.
- **Options:** pnpm + Turborepo, Nx, npm workspaces; uv vs Poetry; Drizzle, Prisma, TypeORM, Kysely.
- **Pros/cons:** pnpm + Turborepo is light and fast. Nx is powerful but heavier. uv is fast with a simple lockfile. Drizzle has native pgvector column support and SQL-first migrations. Prisma has strong developer experience but needs raw SQL/unsupported types for `vector`. TypeORM is Nest-traditional but weaker on typing and pgvector.
- **Cost/ops:** none material.
- **Recommendation:** pnpm workspaces + Turborepo, uv, Drizzle.
- **Blocks:** **Yes.**

### OD-12: Report schema, formats, language
- **Decide:** report JSON schema, rendering, exports, output language.
- **Why:** carries the fact/research/interpretation separation (M-02).
- **Recommendation:** structured JSON source of truth with provenance classes and citations (M-02) and separate audio-diagnostics and transcription-uncertainty caveat sections (M-03). Render in the UI; defer exports. Default output language follows the user's selection.
- **Blocks:** **provenance model yes** (affects A3–A7 contracts); full schema no.

### OD-13: Hindi/Hinglish output script
- **Decide:** stored and displayed script.
- **Options:** Devanagari; romanised; mixed (Devanagari for Hindi words, Latin for English words); multiple layers.
- **Recommendation:** store provider output verbatim (M-01 raw layer). Canonical layer as returned by the provider, normalised only for Unicode (NFC). Transliteration as an optional derived view.
- **Blocks:** **layering yes**; display preference no.

### OD-14: QA failure behaviour
- **Options:** fail the run; bounded revision loop; human review queue.
- **Recommendation:** bounded revision (e.g. ≤2 attempts, configurable), then `needs_review`. Human review UI deferred.
- **Blocks:** no.

### OD-15: Observability
- **Options:** OpenTelemetry + CloudWatch/X-Ray; LLM tracing via LangSmith (SaaS) or Langfuse (self-hostable); none initially.
- **Note:** LLM traces contain transcript content, so this falls under OD-09.
- **Recommendation:** structured JSON logs with run/node correlation IDs from day one. OpenTelemetry later. Prefer self-hostable LLM tracing, or SaaS with redaction.
- **Blocks:** no (logging conventions only).

### OD-16: Progress delivery
- **Options:** SSE; WebSocket; polling.
- **Recommendation:** SSE with heartbeats (load balancer idle timeouts), polling of `GET /runs/{id}` as fallback. Requires I-03.
- **Blocks:** no.

### OD-17: IaC and CI/CD
- **Options:** Terraform; AWS CDK (TypeScript); CloudFormation. GitHub Actions for CI.
- **Recommendation:** CDK (TypeScript, matches the team stack) or Terraform if multi-cloud matters. GitHub Actions for CI from the first commit (lint + unit tests).
- **Blocks:** no (CI is advisable early).

### OD-18: Test corpus
- **Options:** public datasets (e.g. Mozilla Common Voice Hindi (CC0), Google FLEURS, AMI meeting corpus for diarization; Hinglish code-switch corpora, each licence to be verified), plus self-recorded consented audio.
- **Recommendation:** small consented in-house Hinglish set plus licence-verified public sets. Record licences in the repo.
- **Blocks:** no for scaffolding; **yes** for OD-02/OD-03 selection.

### Proposed new open decisions (from this review)
| ID | Decision |
|---|---|
| OD-19 | Unusable-audio policy: stop the run, or continue with caveats (X-01) |
| OD-20 | Whether external research may be disabled per run or per workspace (X-02, §4.6) |
| OD-21 | Worker bounds: concurrency, timeouts, dead-letter, per-run ceilings (M-05) |
| OD-22 | Whether users may edit transcripts or speaker names, and how edits are layered (M-01, X-06) |

---

## 6. Implementation blockers

Before the first vertical slice (upload → preprocess → transcribe → view):

1. **OD-01** agent mapping confirmed.
2. **OD-11** tooling and ORM chosen (enables real commands in CLAUDE.md).
3. **OD-04** integration pattern chosen (spike acceptable).
4. **OD-08** tenancy shape chosen.
5. **OD-09** interim development data policy adopted.
6. **OD-13 / M-01** transcript layering approved.
7. **OD-12 / M-02 / M-03** provenance and two-channel uncertainty approved (affects agent contracts, even if those agents come later).
8. P0 corrections in §7 applied to the docs.

Not blocking: OD-02/03 (fakes first), OD-05, OD-06, OD-07, OD-10 (partial), OD-14–18.

---

## 7. Prioritised corrections

None of these have been applied. All need approval.

### P0: before implementation
1. Confirm whether the §2.2 criteria marked "No" become SRS requirements. If yes, add M-01 to M-03 and M-06 to M-08 to the SRS and propagate them to AGENT, DB and API.
2. Resolve X-01 to X-03 (unusable-audio stop, optional research, FR-11.x) as approve/remove.
3. Fix I-02 (run-scoped preprocessing artefacts).
4. Fix I-05 (test-runner conflict in rules).
5. Add the external-research privacy controls (§4.6) as an OD-09/OD-20 dependency.
6. CLAUDE.md: add development safeguards (see §8): targeted tests, preservation of existing behaviour, never weakening tests.

### P1: before the affected component
7. I-01 reword; I-03 event channel; I-04 event names; I-06 queue routing; I-07 diarization memory policy; I-08 research interface; I-09 segmentation method; I-10/I-11 API gaps.
8. M-04 evidence rules, M-05 worker bounds, M-09 audit, M-10 encryption, M-11 media sandboxing.
9. Add a block-wise processing requirement for quality analysis to the LLD.

### P2: improvements
10. I-12 to I-16.
11. Claude Code configuration items in §8 marked P2.

---

## 8. Claude Code configuration review

| ID | Sev | Finding | Location | Recommendation |
|---|---|---|---|---|
| C-01 | P0 | No instruction to run targeted tests, preserve existing functionality, or avoid weakening/skipping tests. | `CLAUDE.md` | Add a short "Working rules" section: run the narrowest relevant test first, then the affected package's suite; never delete, skip or loosen a test to make it pass; keep changes scoped; report test results faithfully. |
| C-02 | P0 | Test-runner contradiction for `packages/contracts` (I-05). | `.claude/rules/backend-nestjs.md` | Remove that path or fix the runner. |
| C-03 | P1 | Contradiction between the "never load full recording" rule and the documented whole-file diarization (I-07). | `.claude/rules/python-audio.md` vs LLD | Align after the decision. |
| C-04 | P1 | `database.md` path globs (`**/schema.prisma`, `**/db/schema/**`) presuppose ORM choices (OD-11). | `.claude/rules/database.md` | Replace with neutral globs until OD-11, then narrow. |
| C-05 | P1 | Path-scoped rules depend on the *proposed* layout (`apps/orchestrator/src/...`). If the layout changes, rules silently stop applying. | `.claude/rules/*` | Re-check globs when scaffolding (add to the scaffolding checklist). |
| C-06 | P1 | Read-only subagents are granted `Bash`, which can modify files. The "do not edit" rule is instruction-only. | `.claude/agents/*.md` | Keep Bash for `git diff`, but state it is limited to read-only commands; or drop Bash and pass the diff in the prompt. |
| C-07 | P1 | No project permission safeguards (e.g. deny reading `.env*` / secrets files). Changing settings requires your approval. | (absent) `.claude/settings.json` | Propose a minimal `permissions.deny` for secrets files once approved. |
| C-08 | P1 | No `.gitignore`. `.DS_Store` files are already in the working tree; `.env` will follow. | repo root | Add `.gitignore` (approval requested earlier). |
| C-09 | P2 | CLAUDE.md "Project status" must change once implementation is approved. A stale "documentation-only" line will mislead future sessions. | `CLAUDE.md` | Update as part of the scaffolding change. |
| C-10 | P2 | `architecture-reviewer` reads all docs on every invocation. Acceptable (its context is separate), but slow. | agent file | Instruct it to read only the sections relevant to the diff, plus HLD §10. |
| C-11 | P2 | `add-provider-adapter` skill lists "storage", but its steps target orchestrator providers (storage lives in `apps/api`). | skill | Drop storage from the description or add a storage step. |
| C-12 | P2 | Rules have no instruction about the new M-01/M-02/M-03 concepts (pending approval). | rules | Add after the SRS update. |

**Convention check:** the files use the current documented Claude Code layouts: `CLAUDE.md` at the root; `.claude/rules/*.md` with optional `paths:` frontmatter (rules without `paths` load every session); `.claude/agents/*.md` with `name`/`description`/`tools` frontmatter; `.claude/skills/<name>/SKILL.md` with `name`/`description`. These match conventions as I know them but were not re-verified against live docs during this review. **Context cost:** low. Only `documentation.md` (≈6 lines) and `CLAUDE.md` (≈40 lines) load unconditionally; skills load on demand; scoped rules load only for matching files.
