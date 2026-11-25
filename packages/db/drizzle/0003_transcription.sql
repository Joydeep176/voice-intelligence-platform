CREATE TABLE "diarization_raw_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_model" text NOT NULL,
	"scope" text NOT NULL,
	"window_start_ms" bigint,
	"window_end_ms" bigint,
	"payload_uri" text NOT NULL,
	"sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diarization_raw_outputs_scope_valid" CHECK ("diarization_raw_outputs"."scope" IN ('whole', 'window')),
	CONSTRAINT "diarization_raw_outputs_sha256_hex" CHECK ("diarization_raw_outputs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "diarization_raw_outputs_scope_window" CHECK (("diarization_raw_outputs"."scope" = 'whole' AND "diarization_raw_outputs"."window_start_ms" IS NULL AND "diarization_raw_outputs"."window_end_ms" IS NULL) OR ("diarization_raw_outputs"."scope" = 'window' AND "diarization_raw_outputs"."window_start_ms" IS NOT NULL AND "diarization_raw_outputs"."window_end_ms" IS NOT NULL AND "diarization_raw_outputs"."window_start_ms" >= 0 AND "diarization_raw_outputs"."window_start_ms" < "diarization_raw_outputs"."window_end_ms"))
);
--> statement-breakpoint
CREATE TABLE "pipeline_stage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"node" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"progress" jsonb,
	"job_ids" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stage_runs_node_valid" CHECK ("pipeline_stage_runs"."node" IN ('transcription', 'diarization')),
	CONSTRAINT "pipeline_stage_runs_status_valid" CHECK ("pipeline_stage_runs"."status" IN ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "pipeline_stage_runs_attempt_positive" CHECK ("pipeline_stage_runs"."attempt" >= 1),
	CONSTRAINT "pipeline_stage_runs_failed_has_error" CHECK ("pipeline_stage_runs"."status" <> 'failed' OR "pipeline_stage_runs"."error" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "speakers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"speaker_key" text NOT NULL,
	"display_name" text,
	"total_speech_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "speakers_total_speech_nonnegative" CHECK ("speakers"."total_speech_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stt_raw_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"window_index" integer NOT NULL,
	"window_start_ms" bigint NOT NULL,
	"window_end_ms" bigint NOT NULL,
	"provider" text NOT NULL,
	"provider_model" text NOT NULL,
	"request_params" jsonb,
	"payload_uri" text NOT NULL,
	"sha256" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stt_raw_outputs_sha256_hex" CHECK ("stt_raw_outputs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stt_raw_outputs_window_index_nonnegative" CHECK ("stt_raw_outputs"."window_index" >= 0),
	CONSTRAINT "stt_raw_outputs_window_range" CHECK ("stt_raw_outputs"."window_start_ms" >= 0 AND "stt_raw_outputs"."window_start_ms" < "stt_raw_outputs"."window_end_ms")
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transcript_version_id" uuid NOT NULL,
	"speaker_id" uuid,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"text" text NOT NULL,
	"language" text NOT NULL,
	"code_switch_spans" jsonb,
	"confidence" double precision,
	"words" jsonb,
	"source_raw_output_ids" uuid[],
	"source_segment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_segments_range_valid" CHECK ("transcript_segments"."start_ms" >= 0 AND "transcript_segments"."start_ms" < "transcript_segments"."end_ms"),
	CONSTRAINT "transcript_segments_language_valid" CHECK ("transcript_segments"."language" IN ('en', 'hi', 'mixed')),
	CONSTRAINT "transcript_segments_confidence_range" CHECK ("transcript_segments"."confidence" IS NULL OR ("transcript_segments"."confidence" >= 0 AND "transcript_segments"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "transcript_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"base_version_id" uuid,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_versions_version_positive" CHECK ("transcript_versions"."version" >= 1),
	CONSTRAINT "transcript_versions_kind_valid" CHECK ("transcript_versions"."kind" IN ('machine', 'user_correction')),
	CONSTRAINT "transcript_versions_v1_machine" CHECK ("transcript_versions"."version" <> 1 OR "transcript_versions"."kind" = 'machine'),
	CONSTRAINT "transcript_versions_correction_has_base" CHECK ("transcript_versions"."kind" = 'machine' OR "transcript_versions"."base_version_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "transcription_uncertainties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transcript_version_id" uuid NOT NULL,
	"segment_id" uuid,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"kind" text NOT NULL,
	"score" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_uncertainties_range_valid" CHECK ("transcription_uncertainties"."start_ms" >= 0 AND "transcription_uncertainties"."start_ms" <= "transcription_uncertainties"."end_ms"),
	CONSTRAINT "transcription_uncertainties_kind_valid" CHECK ("transcription_uncertainties"."kind" IN ('low_confidence', 'inaudible', 'overlapping_speech', 'language_uncertain', 'speaker_uncertain')),
	CONSTRAINT "transcription_uncertainties_score_range" CHECK ("transcription_uncertainties"."score" IS NULL OR ("transcription_uncertainties"."score" >= 0 AND "transcription_uncertainties"."score" <= 1))
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "preprocessing_id" uuid;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "config" jsonb;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint
-- Composite FK targets must exist before the FKs that reference them (hand-ordered).
CREATE UNIQUE INDEX "speakers_id_workspace_uq" ON "speakers" USING btree ("id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "stt_raw_outputs_id_workspace_uq" ON "stt_raw_outputs" USING btree ("id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_id_workspace_uq" ON "transcript_segments" USING btree ("id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_versions_id_workspace_uq" ON "transcript_versions" USING btree ("id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_id_workspace_uq" ON "transcripts" USING btree ("id","workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_runs_id_workspace_uq" ON "pipeline_runs" USING btree ("id","workspace_id");
--> statement-breakpoint
ALTER TABLE "diarization_raw_outputs" ADD CONSTRAINT "diarization_raw_outputs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "diarization_raw_outputs" ADD CONSTRAINT "diarization_raw_outputs_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."pipeline_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_stage_runs" ADD CONSTRAINT "pipeline_stage_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_stage_runs" ADD CONSTRAINT "pipeline_stage_runs_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."pipeline_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "speakers" ADD CONSTRAINT "speakers_transcript_workspace_fk" FOREIGN KEY ("transcript_id","workspace_id") REFERENCES "public"."transcripts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stt_raw_outputs" ADD CONSTRAINT "stt_raw_outputs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stt_raw_outputs" ADD CONSTRAINT "stt_raw_outputs_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."pipeline_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_version_workspace_fk" FOREIGN KEY ("transcript_version_id","workspace_id") REFERENCES "public"."transcript_versions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_speaker_workspace_fk" FOREIGN KEY ("speaker_id","workspace_id") REFERENCES "public"."speakers"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_source_segment_workspace_fk" FOREIGN KEY ("source_segment_id","workspace_id") REFERENCES "public"."transcript_segments"("id","workspace_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_transcript_workspace_fk" FOREIGN KEY ("transcript_id","workspace_id") REFERENCES "public"."transcripts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcript_versions" ADD CONSTRAINT "transcript_versions_base_workspace_fk" FOREIGN KEY ("base_version_id","workspace_id") REFERENCES "public"."transcript_versions"("id","workspace_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcription_uncertainties" ADD CONSTRAINT "transcription_uncertainties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcription_uncertainties" ADD CONSTRAINT "transcription_uncertainties_version_workspace_fk" FOREIGN KEY ("transcript_version_id","workspace_id") REFERENCES "public"."transcript_versions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcription_uncertainties" ADD CONSTRAINT "transcription_uncertainties_segment_workspace_fk" FOREIGN KEY ("segment_id","workspace_id") REFERENCES "public"."transcript_segments"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."pipeline_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_preprocessing_workspace_fk" FOREIGN KEY ("preprocessing_id","workspace_id") REFERENCES "public"."audio_preprocessings"("id","workspace_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "diarization_raw_outputs_whole_uq" ON "diarization_raw_outputs" USING btree ("run_id") WHERE "diarization_raw_outputs"."scope" = 'whole';
--> statement-breakpoint
CREATE UNIQUE INDEX "diarization_raw_outputs_window_uq" ON "diarization_raw_outputs" USING btree ("run_id","window_start_ms") WHERE "diarization_raw_outputs"."scope" = 'window';
--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_runs_run_node_attempt_uq" ON "pipeline_stage_runs" USING btree ("run_id","node","attempt");
--> statement-breakpoint
CREATE UNIQUE INDEX "speakers_transcript_key_uq" ON "speakers" USING btree ("transcript_id","speaker_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "stt_raw_outputs_run_window_uq" ON "stt_raw_outputs" USING btree ("run_id","window_index");
--> statement-breakpoint
CREATE INDEX "transcript_segments_version_start_idx" ON "transcript_segments" USING btree ("transcript_version_id","start_ms","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_versions_transcript_version_uq" ON "transcript_versions" USING btree ("transcript_id","version");
--> statement-breakpoint
CREATE INDEX "transcription_uncertainties_version_start_idx" ON "transcription_uncertainties" USING btree ("transcript_version_id","start_ms","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_run_uq" ON "transcripts" USING btree ("run_id");
--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_config_object" CHECK ("pipeline_runs"."config" IS NULL OR jsonb_typeof("pipeline_runs"."config") = 'object');
--> statement-breakpoint
-- Immutability (ADR-0007). drizzle-kit cannot express triggers, so they are appended by hand; the
-- snapshot is unaffected. DELETE (cascade from a run or recording) stays allowed.
CREATE FUNCTION "transcription_forbid_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable after insert', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "speakers_forbid_key_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.speaker_key IS DISTINCT FROM OLD.speaker_key
		OR NEW.transcript_id IS DISTINCT FROM OLD.transcript_id
		OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
		RAISE EXCEPTION 'speakers.speaker_key is immutable' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "stt_raw_outputs_immutable" BEFORE UPDATE ON "stt_raw_outputs" FOR EACH ROW EXECUTE FUNCTION "transcription_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "diarization_raw_outputs_immutable" BEFORE UPDATE ON "diarization_raw_outputs" FOR EACH ROW EXECUTE FUNCTION "transcription_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "transcript_versions_immutable" BEFORE UPDATE ON "transcript_versions" FOR EACH ROW EXECUTE FUNCTION "transcription_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "transcript_segments_immutable" BEFORE UPDATE ON "transcript_segments" FOR EACH ROW EXECUTE FUNCTION "transcription_forbid_update"();
--> statement-breakpoint
CREATE TRIGGER "speakers_key_immutable" BEFORE UPDATE ON "speakers" FOR EACH ROW EXECUTE FUNCTION "speakers_forbid_key_change"();
