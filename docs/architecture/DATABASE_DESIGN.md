# Database Design

Status: **Logical model, not implemented.** PostgreSQL + Drizzle ORM (ADR-0005; pgvector compatibility to be verified). The pgvector extension is enabled, but **no embedding tables exist** until OD-06 is revisited (ADR-0011). Items tagged *Proposed* are not approved.

## 1. Conventions

- UUID primary keys; `created_at`/`updated_at` `timestamptz`.
- **Every tenant-owned table carries `workspace_id`** (denormalised for direct filtering and isolation checks, ADR-0003). Postgres RLS as an additional layer: OD-27.
- Audio offsets: integer milliseconds relative to the original recording.
- Blobs in object storage. The DB holds `storage_uri` + `sha256`.
- **Immutable tables** (no UPDATE; DELETE only via recording deletion): `stt_raw_outputs`, `diarization_raw_outputs`, `transcript_versions`, `transcript_segments`, `audit_events`. *Proposed* enforcement: a restricted DB role plus triggers.
- Idempotency: node outputs are unique on (`run_id`, node-specific natural key, `attempt`).
- Migrations only (Drizzle Kit). Update this document in the same change.

## 2. Ownership model

| Scope | Tables |
|---|---|
| Workspace | `workspaces`, `workspace_members`, `audit_events` |
| Recording (immutable source) | `recordings`, `upload_sessions`, `consent_attestations` |
| Preprocessing version: deterministic outputs, shared across runs with the same config (ADR-0015) | `audio_preprocessings`, `audio_segments`, `audio_measurements` |
| Run | `pipeline_runs`, `pipeline_stage_runs`, `llm_calls`, A1 output (`audio_diagnostics`, `audio_diagnostic_flags`), and all transcription/analysis/report tables |

Writers: the preprocessing node writes preprocessing tables (from audio-service results). A1 writes `audio_measurements` (from the service's `measure` task, once per preprocessing version) and its run-scoped diagnostics. A2 writes transcription tables. No agent writes another agent's tables (AGENT_ARCHITECTURE §1).

## 3. Entity overview

```
workspaces 1─* workspace_members, recordings, audit_events
recordings 1─1 consent_attestations ; 1─* upload_sessions ; 1─* audio_preprocessings
audio_preprocessings 1─* audio_segments ; 1─* audio_measurements
recordings 1─* pipeline_runs *─1 audio_preprocessings ; pipeline_runs 1─* audio_diagnostics, audio_diagnostic_flags
pipeline_runs *─1 transcript_versions (source_transcript_version_id, corrected-transcript runs) ; pipeline_runs *─1 pipeline_runs (parent_run_id)
pipeline_runs 1─* pipeline_stage_runs, llm_calls, stt_raw_outputs, diarization_raw_outputs
pipeline_runs 1─1 transcripts 1─* transcript_versions 1─* transcript_segments
transcripts 1─* speakers ; transcript_versions 1─* transcription_uncertainties, transcript_derivations
pipeline_runs 1─* topics, entities, claims, research_queries, research_sources
claims *─* research_sources (claim_evidence) ; claims 1─* claim_validations
pipeline_runs 1─* reports 1─* report_assertions 1─* assertion_refs ; reports 1─* report_exports, qa_reviews 1─* qa_issues
```

## 4. Tables (logical)

### Workspace & access
- **workspaces**: `id`, `name`, `retention_policy` (jsonb, OD-09b), `research_domain_policy` (jsonb, ADR-0009).
- **workspace_members**: `workspace_id`, `user_id`, `role` (values OD-27). `user_id` refers to the deferred IdP subject (OD-08b).
- **audit_events**: `id`, `workspace_id`, `actor_id`, `action`, `resource_type`, `resource_id`, `occurred_at`, `metadata` (jsonb; **no content**). Append-only.

### Recording
- **recordings**: `id`, `workspace_id`, `original_filename`, `storage_uri`, `sha256`, `mime_type`, `size_bytes`, `duration_ms`, `sample_rate`, `channels`, `status` (`uploading|uploaded|validating|valid|invalid|deleting`), `validation_error`.
- **upload_sessions**: `id`, `recording_id`, `workspace_id`, `strategy` (`s3_multipart|local_chunked`), `part_size`, `parts_received` (jsonb: part number → etag/size), `expires_at`, `status`.
- **consent_attestations**: `id`, `recording_id`, `workspace_id`, `attested_by`, `attested_at`, `statement_version`, `scope` (jsonb).

### Preprocessing (ADR-0015)
- **audio_preprocessings**: `id`, `recording_id`, `workspace_id`, `config_hash`, `hash_algorithm`, `config` (jsonb: full canonical configuration), `tool_versions` (jsonb: audio service, Python, FFmpeg, librosa, NumPy, VAD implementation/version), `normalized_uri`, `status`. Unique (`recording_id`, `config_hash`). The hash is never stored without `config` and `tool_versions` (ADR-0015).
- **audio_segments**: `id`, `preprocessing_id`, `index`, `start_ms`, `end_ms`, `overlap_start_ms`, `overlap_end_ms`, `storage_uri`. Unique (`preprocessing_id`, `index`).
- **audio_measurements**: `id`, `preprocessing_id`, `segment_id` (null = whole recording), `measurements` (jsonb: level, noise estimate, clipping ratio, silence ratio, spectral measures), `service_version`. Objective values only; no judgement.

### Audio Quality Agent output (run-scoped)
- **audio_diagnostics**: `id`, `run_id`, `workspace_id`, `preprocessing_id`, `segment_id` (null = whole recording), `overall` (`good|degraded|poor`), `summary`, `rule_version`.
- **audio_diagnostic_flags**: `id`, `run_id`, `start_ms`, `end_ms`, `kind` (`noise|clipping|distortion|dropout|silence|low_level`), `severity`, `measurement_refs` (jsonb).

### Runs
- **pipeline_runs**: `id`, `workspace_id`, `recording_id`, `preprocessing_id`, `parent_run_id` (nullable), `source_transcript_version_id` (nullable; set for corrected-transcript runs, ADR-0020), `status` (`queued|running|cancelling|cancelled|completed|failed|needs_review`), `has_limitations` (bool), `options` (jsonb: language hints, `report_language` en|hi), `config_snapshot` (jsonb: providers, models, prompt versions, bounds), `current_node`, `cancel_requested_at`, `retry_count`, `cost_ceiling`, `cost_total`, `error` (jsonb: code + node, no content), `started_at`, `finished_at`.
- **pipeline_stage_runs**: `id`, `run_id`, `node`, `attempt`, `status`, `progress` (jsonb), `job_ids` (jsonb), `started_at`, `finished_at`, `error`.
- **llm_calls**: `id`, `run_id`, `node`, `model`, `input_tokens`, `output_tokens`, `cost_estimate`, `prompt_version`, `occurred_at`. No prompt or response text.

### Transcription (ADR-0007)
- **stt_raw_outputs**: `id`, `run_id`, `workspace_id`, `segment_id`, `provider`, `provider_model`, `request_params` (jsonb), `payload_uri`, `sha256`, `received_at`. Immutable.
- **diarization_raw_outputs**: `id`, `run_id`, `workspace_id`, `provider`, `scope` (`whole|window`), `window_start_ms`, `window_end_ms`, `payload_uri`, `sha256`. Immutable.
- **transcripts**: `id`, `run_id`, `workspace_id`.
- **transcript_versions**: `id`, `transcript_id`, `version`, `kind` (`machine|user_correction`), `base_version_id`, `created_by`, `note`. Immutable. v1 is always `machine`.
- **speakers**: `id`, `transcript_id`, `speaker_key` (machine ID, immutable), `display_name` (user-editable, audited), `total_speech_ms`.
- **transcript_segments**: `id`, `transcript_version_id`, `speaker_id`, `start_ms`, `end_ms`, `text` (original script as produced/corrected), `language` (`en|hi|mixed`), `code_switch_spans` (jsonb), `confidence`, `words` (jsonb), `source_raw_output_ids` (uuid[]; machine versions), `source_segment_id` (corrections). Index (`transcript_version_id`, `start_ms`).
- **transcription_uncertainties**: `id`, `transcript_version_id`, `segment_id`, `start_ms`, `end_ms`, `kind` (`low_confidence|inaudible|overlapping_speech|language_uncertain|speaker_uncertain`), `score`. No reference to audio diagnostics; the two channels are related only at report time, by time overlap.
- **transcript_derivations**: `id`, `transcript_version_id`, `kind` (`transliteration|translation|normalisation`), `target` (script or language), `method` (OD-24b), `created_at`. **derived_segments**: `id`, `derivation_id`, `source_segment_id`, `text`.

### Analysis
- **topics**: `id`, `run_id`, `label`, `summary`, `provenance` = `inferred`, `spans` (jsonb).
- **entities**: `id`, `run_id`, `name`, `type`, `mention_spans` (jsonb; recorded), `type_provenance` = `inferred`.
- **claims**: `id`, `run_id`, `quoted_text` (verbatim), `normalized_text` (inferred, optional), `speaker_id`, `spans` (jsonb with `transcript_version_id`), `checkable`, `category`.
- **research_queries**: `id`, `run_id`, `workspace_id`, `attempt` (1 or 2), `question_ref`, `query_text` (exactly as sent), `provider`, `minimisation` (jsonb: rules applied), `issued_at`.
- **research_sources**: `id`, `run_id`, `url`, `title`, `publisher`, `published_at`, `retrieved_at`, `retrieval` (`fetched|snippet_only`), `snapshot_uri`, `sha256`, `provider`.
- **claim_evidence**: `id`, `claim_id`, `source_id`, `stance` (`supports|contradicts|context`), `quoted_text` (verbatim from snapshot), `locator`. CHECK: the source's `retrieval = 'fetched'` for `supports|contradicts` (enforced in application; *Proposed* trigger).
- **claim_validations**: `id`, `claim_id`, `verdict` (taxonomy *Proposed*, AGENT §4), `confidence`, `rationale`, `research_attempts`.

### Reporting & QA
- **reports**: `id`, `run_id`, `version`, `language` (`en|hi`), `transcript_version_id`, `status` (`draft|qa_passed|qa_failed|needs_review`), `model` (jsonb canonical structured report). Unique (`run_id`, `version`).
- **report_assertions**: `id`, `report_id`, `section`, `ordinal`, `text`, `provenance` (`recorded|external|inferred`), `confidence` (required when inferred), `rationale` (inferred).
- **assertion_refs**: `id`, `assertion_id`, `ref_type` (`transcript_span|evidence|assertion`), `transcript_segment_id`, `start_ms`, `end_ms`, `evidence_id`, `basis_assertion_id`. Required: recorded → ≥1 `transcript_span`; external → ≥1 `evidence`; inferred → ≥1 basis.
- **report_exports**: `id`, `report_id`, `format` (`pdf|docx`), `status`, `storage_uri`, `created_by`.
- **qa_reviews**: `id`, `report_id`, `attempt`, `result`, `summary`. **qa_issues**: `id`, `qa_review_id`, `severity`, `kind` (`missing_provenance|provenance_mismatch|unresolved_reference|quote_mismatch|insufficient_evidence|verdict_contradiction|missing_section|diagnostics_uncertainty_conflation|language_mismatch`), `location`.

## 5. Library-managed

- LangGraph PostgreSQL checkpointer tables in a separate schema (*Proposed* `langgraph`). Thread ID = run ID.
- BullMQ state lives in Redis only.

## 6. Deletion (SEC-6)

Deleting a recording sets status `deleting` and enqueues a `deletion` job that removes, in order:
1. Queued/active jobs for its runs (cancelled first).
2. LangGraph checkpoints for its run threads.
3. Storage objects: original, normalised audio, segments, raw provider payloads, source snapshots, exports. In S3 this includes all object versions.
4. DB rows (cascade from the recording).
5. An `audit_events` record of the deletion (IDs only) is kept.
Logs and traces hold no content (SEC-9), so they need no content deletion. Backup expiry and vendor-side copies: before production (OD-09b).
