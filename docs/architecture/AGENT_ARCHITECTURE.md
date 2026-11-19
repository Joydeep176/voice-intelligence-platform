# Agent Architecture

Status: **Seven agents approved (ADR-0001, amended by ADR-0019); parallel A1/A2 accepted provisionally (ADR-0021).** Items tagged *Proposed* are not approved.
These are the product's runtime agents. They are unrelated to Claude Code's development subagents in `.claude/agents/`.

## 1. Stages and agents

| ID | Stage / agent | Steps | Nature | Writes |
|---|---|---|---|---|
| — | Ingestion | 1 | Deterministic (API + audio-service probe) | `recordings`, `upload_sessions`, `consent_attestations` |
| — | **Preprocessing node** | 2 | Deterministic graph node. Calls the audio service for FFmpeg decoding, normalisation, VAD and segmentation (ADR-0019) | `audio_preprocessings`, `audio_segments` |
| A1 | **Audio Quality Agent** | 3 | Analyses objective audio measurements and produces its own diagnostic output (*Proposed*: rule-based, no LLM in v1) | `audio_measurements` (via service, preprocessing-scoped), `audio_diagnostics`, `audio_diagnostic_flags` (run-scoped) |
| A2 | **Transcription Agent** | 4, 5 | Transcription, language identification, diarization, speaker alignment, transcription uncertainty | `stt_raw_outputs`, `diarization_raw_outputs`, `transcripts`, `transcript_versions` (machine), `transcript_segments`, `speakers`, `transcription_uncertainties` |
| A3 | **Context Intelligence Agent** | 6 | LLM | `topics`, `entities`, `claims` |
| A4 | **Research Agent** | 7 | Tool-using LLM via `ResearchProvider` (ADR-0017) | `research_queries`, `research_sources` |
| A5 | **Fact Validation Agent** | 8 | LLM over evidence | `claim_evidence`, `claim_validations` |
| A6 | **Reporting Agent** | 9 | LLM structured generation | `reports`, `report_assertions`, `assertion_refs` |
| A7 | **QA Agent** | 10 | Rule checks + LLM. **Read-only** | `qa_reviews`, `qa_issues` only |

### Boundaries
- **The preprocessing node and the audio service make no quality judgements.** They transform audio and measure it.
- **A1 owns audio diagnostics only.** Its inputs are objective measurements (computed block-wise by the audio service at A1's request). Its output is its own diagnostic classification, flags and summary. It never reads or writes transcription data.
- **A2 owns transcription, language identification, diarization and transcription uncertainty only.** It never reads or writes audio diagnostics. Diagnostics and uncertainty are related only at report time, by time overlap (A6). A1 and A2 cannot overwrite or consume each other's output (§2.2).
- **A2 never modifies raw provider output.** Machine version v1 is built from raw output and references it.
- **A3 separates quotation from interpretation.** `claims.quoted_text` is verbatim; paraphrases and topics are `inferred`.
- **A4 is the only agent that sends data to the research provider** (ADR-0009).
- **A5 needs snapshot-backed evidence** for `supported`/`contradicted`/`partially_supported` (FR-8.2).
- **A6 assigns provenance to every assertion** and keeps the *Audio limitations* and *Transcription uncertainty* sections separate.
- **A7 writes only its own QA records.** This is enforced at the repository layer.

## 2. Graph topology and dependencies

```
START
  │
  ▼
[Preprocessing node]  deterministic; audio service: decode → normalise → VAD → segment
  │                   undecodable audio → END (failed)
  ├───────────────────────────────┐        independent parallel branches (ADR-0021)
  ▼                               ▼
[A1 Audio Quality]           [A2 Transcription]
 measurements → diagnostics    STT fan-out (BullMQ flow) → stitch → language ID
 poor quality → continue       → diarize → align → uncertainty
 (ADR-0008)                       │
  │                               ▼
  │                         [A3 Context Intelligence]
  │                               │
  │                               ▼
  │                         [A4 Research] (always runs)
  │                               │
  │                               ▼
  │                         [A5 Fact Validation] ──unresolved claims, research attempts = 1──▶ [A4 targeted retry] ──▶ [A5]
  │                               │                 (exactly one retry per run, ADR-0014)
  └──────────────┬────────────────┘
                 ▼  waits for A1 AND A5
[A6 Reporting]
  │
  ▼
[A7 QA] ──pass──▶ END (completed)
  └──fail──▶ OD-14 (Proposed: limited revision attempts via A6, then END needs_review)
```

### 2.1 Required upstream results

| Node | Starts only when these have completed for the run |
|---|---|
| A1 Audio Quality | Preprocessing |
| A2 Transcription | Preprocessing |
| A3 Context Intelligence | A2 (machine transcript version), or the source transcript version for corrected-transcript runs (ADR-0020) |
| A4 Research | A3 |
| A5 Fact Validation | A4 (and the targeted retry, if triggered) |
| A6 Reporting | **A1 and A5** (and therefore A2–A4) |
| A7 QA | A6 |

- **Independence (ADR-0021):** after preprocessing, A1 and A2 run independently and in parallel. Neither waits for, consumes or overwrites the other's output. A3–A5 do not depend on A1.
- **Waiting:** a downstream node never starts on partial upstream results. A6 is the first and only join of the two branches. The exact join mechanism (LangGraph multi-source edges/deferred node) is to be confirmed by graph-level validation.
- **Failure:** poor audio is not a failure (ADR-0008). A technical failure of either branch, after its bounded retries, stops downstream nodes that need its result. The run fails and stays retryable from its checkpoint (ADR-0014). Cancellation stops both branches.
- **Corrected-transcript runs** (ADR-0020) skip preprocessing, A1 and A2, and reference the parent run's diagnostics and the source transcript version (mechanism OD-26b, *Proposed*).
- The cost ceiling is checked by the LLM factory before every call (behaviour OD-28). Nodes are idempotent, with outputs keyed by (`run_id`, node, attempt).

### 2.2 Enforcing A1/A2 separation
- **Inputs:** A1 receives the preprocessing version only; A2 receives the preprocessing version (segments) only. Neither node's input includes the other's output.
- **State:** A1 writes only the `audioQuality` state key; A2 writes only `transcript`. Concurrent branch writes go to disjoint keys; shared keys (`errors`) use an append reducer.
- **Persistence:** each agent's repository exposes write methods only for its own tables (AGENT §1). The A1 repository has no transcription-table access and the A2 repository has no diagnostics-table access, enforced in code and tested (TESTING §3).

## 3. Shared graph state (illustrative, not implemented)

```ts
interface PipelineState {
  runId: string; workspaceId: string; recordingId: string;
  options: { languageHints?: ('en' | 'hi')[]; reportLanguage: 'en' | 'hi'; sourceTranscriptVersionId?: string };
  preprocessingId?: string;
  audioQuality?: { overall: 'good' | 'degraded' | 'poor'; flagCount: number };   // A1 only
  transcript?: { transcriptId: string; versionId: string; speakerCount: number; languages: string[] }; // A2 only
  context?: { claimCount: number; unresolvedClaimIds?: string[] };
  research?: { attempts: number /* max 2: initial + one targeted retry */ };
  reportId?: string;
  qa?: { status: 'pass' | 'fail'; attempts: number };
  errors: { node: string; code: string; retryable: boolean }[];   // no content
}
```

## 4. Contracts

### Preprocessing node (deterministic)
- In: recording. Out: preprocessing version (reused when `config_hash` matches, ADR-0015), stored with its reproducible configuration and tool-version metadata; segments.
- Calls audio-service `probe` and `preprocess` tasks. VAD method: OD-29.

### A1 Audio Quality
- In: preprocessing version. Requests the audio-service `measure` task (objective, block-wise measurements, stored per preprocessing version) and then classifies them.
- Out (run-scoped): overall verdict, flags (`noise`, `clipping`, `distortion`, `dropout`, `silence`, `low_level`) with severity and timestamps, summary.

### A2 Transcription
- In: preprocessing version (segments). Out: raw outputs, machine transcript version, speakers, uncertainties.
- Steps: per-segment STT → store raw output verbatim → stitch overlaps → language identification per segment with code-switch spans → diarize with bounded memory for any recording length (ADR-0016) → align → record uncertainties (`low_confidence`, `inaudible`, `overlapping_speech`, `language_uncertain`, `speaker_uncertain`).
- Adapters only (`SpeechToTextProvider`, `DiarizationProvider`); fakes in development (ADR-0012).

### A3 Context Intelligence
- In: transcript version. Out: topics (`inferred`), entities (mention spans `recorded`, type `inferred`), claims (verbatim `quoted_text` + spans, optional `normalized_text`).

### A4 Research
- In: claims and context. Out: queries exactly as sent, and sources with snapshots. Minimised queries (ADR-0009). Targeted retry once, for unresolved claims only.

### A5 Fact Validation
- In: claims, sources. Out: evidence links (verbatim from snapshots) and validations. Taxonomy: OD-30 (*Proposed*). Snippet-only sources never support a verdict.

### A6 Reporting
- In: all artefacts plus `reportLanguage`. Out: versioned report with assertions (`recorded` → transcript span refs; `external` → evidence refs; `inferred` → basis refs + confidence + rationale). Separate *Audio limitations* and *Transcription uncertainty* sections. The canonical structured model renders to HTML and is exported to PDF/DOCX (ADR-0006; library OD-25).

### A7 QA
- Checks provenance presence and type, reference resolution, quote fidelity, evidence sufficiency, consistency with verdicts, required sections, diagnostics/uncertainty separation, and report language. Output: pass/fail and issues. Never edits.

## 5. LLM usage rules

- Claude only through the LLM factory: per-agent model from config, retries, budget check, `llm_calls` recorded (ADR-0013).
- zod-validated structured outputs with bounded repair retries, then `SchemaError`.
- Versioned prompts next to each agent. Prompt versions are stored in the run config snapshot.
- Transcript and web content are untrusted and kept separate from instructions. Prompts, responses and transcript text are never logged.

## 6. Execution model (ADR-0002 and ADR-0018, both provisional)

Node/NestJS owns all BullMQ queues. LangGraph runs inside orchestrator jobs with a Postgres checkpointer (thread = run ID). Long operations run as BullMQ jobs; the graph pauses and resumes from its checkpoint. This mechanism is to be validated by the ADR-0002 prototype.
