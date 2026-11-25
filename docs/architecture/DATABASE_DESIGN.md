# Database Design

Status: **Logical model; Phase 1 subset implemented** (`packages/db`): `workspaces` (id, name, timestamps), `recordings` (no `validation_error` codes beyond `MEDIA_SIGNATURE_MISMATCH` yet), `upload_sessions`, `consent_attestations` (without `scope`), `pipeline_runs` (id, workspace_id, recording_id, status, current_node, error, retry_count, started_at, finished_at, timestamps; the other columns arrive with the pipeline) and `audit_events`. Enum values are imported from `@vip/contracts`. pgvector is enabled by migration `0000_enable_pgvector` (ADR-0005 check: covered by the db integration test). PostgreSQL + Drizzle ORM (ADR-0005; pgvector compatibility to be verified). The pgvector extension is enabled, but **no embedding tables exist** until OD-06 is revisited (ADR-0011). Items tagged *Proposed* are not approved.

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

Writers: the preprocessing node writes preprocessing tables (from audio-service results). `audio_measurements` are written by the same preprocessing coordinator from the audio service's objective measurements, once per preprocessing version (ADR-0019: the service computes measurements and makes no judgements; ADR-0015: measurements belong to the preprocessing version). A1 reads them and writes only its run-scoped diagnostics. (Corrected 2026-11-21 to conform to ADR-0019; the earlier text assigned the write to A1.) A2 writes transcription tables. No agent writes another agent's tables (AGENT_ARCHITECTURE §1).

## 3. Entity overview

```
workspaces 1─* workspace_members, recordings, audit_events
recordings 1─1 consent_attestations ; 1─* upload_sessions ; 1─* audio_preprocessings
audio_preprocessings 1─* audio_segments ; 1─* audio_measurements ; audio_segments 0..1─* audio_measurements
(composite FKs carry workspace_id: a child row cannot reference a parent in another workspace)
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
- **recordings**: `id`, `workspace_id`, `original_filename`, `storage_uri`, `sha256`, `mime_type`, `size_bytes`, `duration_ms`, `sample_rate`, `channels`, `status` (`uploading|uploaded|validating|valid|invalid|deleting`), `validation_error`, `media_probe` (jsonb, see Preprocessing).
- **upload_sessions**: `id`, `recording_id`, `workspace_id`, `strategy` (`s3_multipart|local_chunked`), `part_size`, `total_parts` (integer, not null, CHECK > 0), `parts_received` (jsonb: part number → etag/size), `expires_at`, `status`.
- **consent_attestations**: `id`, `recording_id`, `workspace_id`, `attested_by`, `attested_at`, `statement_version`, `scope` (jsonb).

### Preprocessing (ADR-0015)
Migration `0002_audio_processing` (Phase 2B workstream 2; additive; SQL reviewed by Opus and applied to the development database on 2026-11-21 after a `pg_dump` backup; the 23 existing recordings verified unchanged by row fingerprint). `recordings.duration_ms` holds the probe value (container header, or the packet extent when the header is absent); the authoritative decoded duration of a processed version is `audio_preprocessings.canonical_duration_ms` (plan §11.2 rule 5). `audio_preprocessings.status = 'running'` means submitted to the audio service, which executes one task at a time; others wait in its bounded queue. Implementation: `packages/db/src/schema.ts`, shared repository functions in `packages/db/src/audio-processing.ts`.

- **recordings** (additions): `media_probe` jsonb NULL (CHECK object; container, codec, bit rate, decode class, probe tool versions) and unique index `recordings_id_workspace_uq (id, workspace_id)`, the target of the composite workspace FKs below.
- **audio_preprocessings**: `id`, `workspace_id` (RESTRICT), `recording_id`, `config_hash` (CHECK `^[0-9a-f]{64}$`), `hash_algorithm` (default `sha256`), `config` (jsonb: full canonical configuration), `tool_versions` (jsonb: audio service, Python, FFmpeg, librosa, NumPy, VAD implementation/version), `status` (`preprocessing_status`: `queued|running|succeeded|failed|cancelled`, default `queued`), `progress` (jsonb), `attempt` (integer, default 0, CHECK >= 0), `error` (jsonb `{code, retryable}` only, CHECK object), `cancel_requested_at`, `normalized_uri`, `canonical_sha256` (CHECK hex 64), `canonical_duration_ms` (CHECK >= 0), `vad` (jsonb), `timeline` (jsonb, CHECK object; mapping record, plan §11.2), `artifacts` (jsonb), `started_at`, `finished_at` (CHECK finished >= started), timestamps. Composite FK (`recording_id`, `workspace_id`) → `recordings(id, workspace_id)` ON DELETE CASCADE. Unique (`recording_id`, `config_hash`) and (`id`, `workspace_id`); index (`workspace_id`, `recording_id`, `created_at` DESC). Lifecycle CHECKs: `succeeded` requires `finished_at`, `canonical_sha256`, `normalized_uri`, `canonical_duration_ms` and `timeline`; `failed` requires `error`. The hash is never stored without `config` and `tool_versions` (ADR-0015). The lifecycle lives on this row (no jobs table); guarded conditional UPDATEs in the repository prevent backwards moves.
- **audio_segments** (immutable after insert): `id`, `workspace_id` (RESTRICT), `preprocessing_id`, `index` (CHECK >= 0), `start_ms`, `end_ms` (CHECK `0 <= start_ms < end_ms`; half-open on the canonical timeline), `overlap_start_ms`, `overlap_end_ms` (default 0, CHECK >= 0), `speech_ms` (CHECK `0 <= speech_ms <= end_ms - start_ms`), `contains_synthetic_gap` (boolean, default false), `storage_uri`. Composite FK (`preprocessing_id`, `workspace_id`) → `audio_preprocessings(id, workspace_id)` CASCADE. Unique (`preprocessing_id`, `index`) and (`id`, `preprocessing_id`); index (`preprocessing_id`, `start_ms`).
- **audio_measurements** (immutable after insert): `id`, `workspace_id` (RESTRICT), `preprocessing_id`, `segment_id` (null = whole recording), `source` (CHECK `original_decoded|canonical`), `schema_version`, `measurements` (jsonb, CHECK object: level, noise estimate, clipping ratio, silence ratio, spectral measures), `series_uri`, `service_version`, `created_at`. Composite FKs (`preprocessing_id`, `workspace_id`) → `audio_preprocessings(id, workspace_id)` CASCADE and (`segment_id`, `preprocessing_id`) → `audio_segments(id, preprocessing_id)` CASCADE (the segment must belong to the same version). Partial unique (`preprocessing_id`, `source`) WHERE `segment_id IS NULL`; partial unique (`preprocessing_id`, `segment_id`, `source`) WHERE `segment_id IS NOT NULL`; index (`preprocessing_id`). Objective values only; no judgement.
- **Immutability enforcement** (implemented for these two tables only): trigger function `audio_forbid_update()` raises (SQLSTATE 23001) on any UPDATE of `audio_segments` or `audio_measurements`; DELETE by cascade from a recording stays allowed (SEC-6). Triggers are appended by hand to the generated migration (drizzle-kit cannot express them; the snapshot is unaffected).
- **Migration notes**: the three composite-FK target unique indexes are hand-ordered before the FKs in the SQL file (drizzle-kit emits FKs first, which Postgres rejects). **Rollback** (no down-migration convention in this repo; run manually, in this order, then delete the `0002` row from `drizzle.__drizzle_migrations`):
  `DROP TRIGGER audio_measurements_immutable ON audio_measurements; DROP TRIGGER audio_segments_immutable ON audio_segments; DROP FUNCTION audio_forbid_update(); DROP TABLE audio_measurements; DROP TABLE audio_segments; DROP TABLE audio_preprocessings; ALTER TABLE recordings DROP CONSTRAINT recordings_media_probe_object; DROP INDEX recordings_id_workspace_uq; ALTER TABLE recordings DROP COLUMN media_probe; DROP TYPE preprocessing_status;`

### Audio Quality Agent output (run-scoped)
- **audio_diagnostics**: `id`, `run_id`, `workspace_id`, `preprocessing_id`, `segment_id` (null = whole recording), `overall` (`good|degraded|poor`), `summary`, `rule_version`.
- **audio_diagnostic_flags**: `id`, `run_id`, `start_ms`, `end_ms`, `kind` (`noise|clipping|distortion|dropout|silence|low_level`), `severity`, `measurement_refs` (jsonb).

### Runs
- **pipeline_runs**: `id`, `workspace_id`, `recording_id`, `preprocessing_id`, `parent_run_id` (nullable), `source_transcript_version_id` (nullable; set for corrected-transcript runs, ADR-0020), `status` (`created|queued|running|cancelling|cancelled|completed|failed|needs_review`; `created` = recorded at upload, not yet submitted to the pipeline, ADR-0025), `has_limitations` (bool), `options` (jsonb: language hints, `report_language` en|hi), `config_snapshot` (jsonb: providers, models, prompt versions, bounds), `current_node`, `cancel_requested_at`, `retry_count`, `cost_ceiling`, `cost_total`, `error` (jsonb: code + node, no content), `started_at`, `finished_at`.
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

**Implementation status (Phase 2C, migration `0003_transcription`; interim, for the user's confirmation, D-2C-01..03).** Implemented: `pipeline_runs` additions, `pipeline_stage_runs`, `stt_raw_outputs`, `diarization_raw_outputs`, `transcripts`, `transcript_versions`, `speakers`, `transcript_segments`, `transcription_uncertainties`. Not implemented: `transcript_derivations`, `derived_segments`, `audio_diagnostics`, `llm_calls` and the analysis tables. Differences from the logical design above:

- `pipeline_runs` gained `preprocessing_id` (nullable; composite FK `(preprocessing_id, workspace_id)` to `audio_preprocessings`, set when the run is submitted), `config` (jsonb: stage scope, language hints, provider ids/versions with a `fake` flag, window source and parameters; written at submission and merged by the orchestrator when the run starts) and `cancel_requested_at`. `config` is the implemented form of `options`/`config_snapshot` for this scope. `parent_run_id`, `source_transcript_version_id`, `has_limitations` and cost columns are not added yet.
- `pipeline_stage_runs`: `workspace_id` added; one row per (`run_id`, `node`, `attempt`) with `attempt = retry_count + 1`; `node` is `transcription` or `diarization`; `status` is `running|completed|failed|cancelled` (a stage with no row is reported as `pending`); `error` is `{ code }` only.
- `stt_raw_outputs`: `segment_id` is replaced by `window_index`, `window_start_ms`, `window_end_ms` (the VAD `audio_segments.index` or the fixed-window index), unique per (`run_id`, `window_index`). `diarization_raw_outputs` gained `provider_model`; a partial unique index allows one `whole` row per run. Both are immutable (UPDATE trigger); the bytes live at `payload_uri` and match `sha256`. The orchestrator's raw store is write-once (Phase 2C completion): an object is created only if its key is free, from an fsynced temp file in one atomic `link`, and is never replaced; the row is inserted only after the object exists; an object left by a stopped attempt (no row yet) is adopted instead of re-requesting the provider.
- `transcripts` is unique on `run_id`. `transcript_versions` is unique on (`transcript_id`, `version`); CHECKs force v1 to be `machine` and a correction to have a `base_version_id`. `speakers.speaker_key` is immutable (trigger blocks changes to key, transcript and workspace; `display_name` stays editable). `transcript_segments.confidence` is NULL when the provider gave none (never estimated) and CHECKed to 0..1; times CHECKed `0 <= start < end`; language CHECKed `en|hi|mixed`. `transcription_uncertainties` is immutable (UPDATE trigger, migration `0004_transcription_integrity`), as rows of an immutable version.
- Every new table has `workspace_id` and composite `(parent_id, workspace_id)` FKs (unique indexes `*_id_workspace_uq` on the parents), so a child can never reference another workspace's parent. Cascades: run and recording deletion cascade through all of them; the segment-to-speaker FK also cascades because speakers only die with their transcript (a NO ACTION FK would be checked part-way through the transcript cascade). Migration `0004_transcription_integrity` enforces that: a BEFORE DELETE trigger refuses a direct `DELETE` of a speaker (`pg_trigger_depth() <= 1`), so it can never remove segments of an immutable version; deletes arriving through a foreign-key cascade stay allowed. Rollback of 0004: `DROP TRIGGER transcription_uncertainties_immutable ON transcription_uncertainties; DROP TRIGGER speakers_no_direct_delete ON speakers; DROP FUNCTION speakers_forbid_direct_delete();` **Status (2026-11-24): applied to the development database `vip` after a verified backup (`.local-backups/pre-0004-20261124T150407.dump`, restored into a scratch database with identical row fingerprints); migration history shows 5 entries; both triggers and the function exist; the 10 data fingerprints were unchanged by the migration. Its integration tests pass on `vip_test`.**
- Transcript v1 is persisted by one repository transaction (`completeRunWithTranscript`): it locks the run, inserts the transcript (unique `run_id`, so a second completion is a no-op), moves the run `running -> completed` (a cancelling run rolls everything back), then inserts the version, speakers (with computed `total_speech_ms`), segments and uncertainties.

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
