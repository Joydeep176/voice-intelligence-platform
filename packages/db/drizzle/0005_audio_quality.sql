CREATE TABLE "audio_diagnostic_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"diagnostics_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"start_ms" bigint,
	"end_ms" bigint,
	"basis" text NOT NULL,
	"rule_id" text NOT NULL,
	"measurement_refs" jsonb NOT NULL,
	CONSTRAINT "audio_diagnostic_flags_kind_valid" CHECK ("audio_diagnostic_flags"."kind" IN ('noise', 'clipping', 'distortion', 'dropout', 'silence', 'low_level', 'low_speech_presence', 'narrowband', 'level_inconsistency', 'fragmented_speech')),
	CONSTRAINT "audio_diagnostic_flags_severity_valid" CHECK ("audio_diagnostic_flags"."severity" IN ('low', 'medium', 'high')),
	CONSTRAINT "audio_diagnostic_flags_basis_valid" CHECK ("audio_diagnostic_flags"."basis" IN ('measured', 'derived', 'estimate')),
	CONSTRAINT "audio_diagnostic_flags_range_valid" CHECK (("audio_diagnostic_flags"."start_ms" IS NULL AND "audio_diagnostic_flags"."end_ms" IS NULL) OR ("audio_diagnostic_flags"."start_ms" >= 0 AND "audio_diagnostic_flags"."end_ms" > "audio_diagnostic_flags"."start_ms")),
	CONSTRAINT "audio_diagnostic_flags_refs_array" CHECK (jsonb_typeof("audio_diagnostic_flags"."measurement_refs") = 'array')
);
--> statement-breakpoint
CREATE TABLE "audio_diagnostics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"preprocessing_id" uuid NOT NULL,
	"measurement_set_id" uuid,
	"attempt" integer NOT NULL,
	"rule_version" text NOT NULL,
	"provisional" boolean NOT NULL,
	"overall" text NOT NULL,
	"confidence" text NOT NULL,
	"suitability" jsonb NOT NULL,
	"not_assessed" jsonb NOT NULL,
	"recommendations" jsonb NOT NULL,
	"affected_ratio" double precision,
	"tier1" text NOT NULL,
	"rule_config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_diagnostics_overall_valid" CHECK ("audio_diagnostics"."overall" IN ('good', 'acceptable_with_warnings', 'poor', 'insufficient')),
	CONSTRAINT "audio_diagnostics_confidence_valid" CHECK ("audio_diagnostics"."confidence" IN ('high', 'medium', 'low')),
	CONSTRAINT "audio_diagnostics_attempt_positive" CHECK ("audio_diagnostics"."attempt" >= 1),
	CONSTRAINT "audio_diagnostics_affected_ratio_range" CHECK ("audio_diagnostics"."affected_ratio" IS NULL OR ("audio_diagnostics"."affected_ratio" >= 0 AND "audio_diagnostics"."affected_ratio" <= 1)),
	CONSTRAINT "audio_diagnostics_suitability_object" CHECK (jsonb_typeof("audio_diagnostics"."suitability") = 'object'),
	CONSTRAINT "audio_diagnostics_not_assessed_array" CHECK (jsonb_typeof("audio_diagnostics"."not_assessed") = 'array'),
	CONSTRAINT "audio_diagnostics_recommendations_array" CHECK (jsonb_typeof("audio_diagnostics"."recommendations") = 'array')
);
--> statement-breakpoint
CREATE TABLE "audio_measurement_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preprocessing_id" uuid NOT NULL,
	"config_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"series_uri" text,
	"tool_versions" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_measurement_sets_config_hash_hex" CHECK ("audio_measurement_sets"."config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_measurement_sets_status_valid" CHECK ("audio_measurement_sets"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "audio_measurement_sets_attempt_nonnegative" CHECK ("audio_measurement_sets"."attempt" >= 0),
	CONSTRAINT "audio_measurement_sets_failed_has_error" CHECK ("audio_measurement_sets"."status" <> 'failed' OR "audio_measurement_sets"."error" IS NOT NULL),
	CONSTRAINT "audio_measurement_sets_succeeded_complete" CHECK ("audio_measurement_sets"."status" <> 'succeeded' OR ("audio_measurement_sets"."finished_at" IS NOT NULL AND "audio_measurement_sets"."series_uri" IS NOT NULL))
);
--> statement-breakpoint
-- Unique targets of the composite FKs below are created first (moved by hand from drizzle-kit's order).
CREATE UNIQUE INDEX "audio_diagnostics_id_workspace_uq" ON "audio_diagnostics" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurement_sets_preprocessing_config_uq" ON "audio_measurement_sets" USING btree ("preprocessing_id","config_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurement_sets_id_preprocessing_uq" ON "audio_measurement_sets" USING btree ("id","preprocessing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurement_sets_id_workspace_uq" ON "audio_measurement_sets" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "pipeline_stage_runs" DROP CONSTRAINT "pipeline_stage_runs_node_valid";--> statement-breakpoint
DROP INDEX "audio_measurements_whole_uq";--> statement-breakpoint
ALTER TABLE "audio_measurements" ADD COLUMN "measurement_set_id" uuid;--> statement-breakpoint
ALTER TABLE "audio_diagnostic_flags" ADD CONSTRAINT "audio_diagnostic_flags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_diagnostic_flags" ADD CONSTRAINT "audio_diagnostic_flags_diagnostics_workspace_fk" FOREIGN KEY ("diagnostics_id","workspace_id") REFERENCES "public"."audio_diagnostics"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_diagnostics" ADD CONSTRAINT "audio_diagnostics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_diagnostics" ADD CONSTRAINT "audio_diagnostics_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."pipeline_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_diagnostics" ADD CONSTRAINT "audio_diagnostics_preprocessing_workspace_fk" FOREIGN KEY ("preprocessing_id","workspace_id") REFERENCES "public"."audio_preprocessings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_diagnostics" ADD CONSTRAINT "audio_diagnostics_set_preprocessing_fk" FOREIGN KEY ("measurement_set_id","preprocessing_id") REFERENCES "public"."audio_measurement_sets"("id","preprocessing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_measurement_sets" ADD CONSTRAINT "audio_measurement_sets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_measurement_sets" ADD CONSTRAINT "audio_measurement_sets_preprocessing_workspace_fk" FOREIGN KEY ("preprocessing_id","workspace_id") REFERENCES "public"."audio_preprocessings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_diagnostic_flags_diagnostics_start_idx" ON "audio_diagnostic_flags" USING btree ("diagnostics_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_diagnostics_run_attempt_uq" ON "audio_diagnostics" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "audio_diagnostics_run_idx" ON "audio_diagnostics" USING btree ("run_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "audio_measurements" ADD CONSTRAINT "audio_measurements_set_preprocessing_fk" FOREIGN KEY ("measurement_set_id","preprocessing_id") REFERENCES "public"."audio_measurement_sets"("id","preprocessing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurements_set_uq" ON "audio_measurements" USING btree ("measurement_set_id","source") WHERE "audio_measurements"."measurement_set_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurements_whole_uq" ON "audio_measurements" USING btree ("preprocessing_id","source") WHERE "audio_measurements"."segment_id" IS NULL AND "audio_measurements"."measurement_set_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stage_runs" ADD CONSTRAINT "pipeline_stage_runs_node_valid" CHECK ("pipeline_stage_runs"."node" IN ('transcription', 'diarization', 'audio_quality'));--> statement-breakpoint
-- Phase 3A (ADR-0043 / ADR-0044): A1 diagnostics are immutable after insert; a re-assessment
-- inserts a new row (new attempt). drizzle-kit cannot express triggers, so they are appended by
-- hand (snapshot unaffected). DELETE (cascade from the run or recording) stays allowed (SEC-6).
CREATE TRIGGER "audio_diagnostics_immutable" BEFORE UPDATE ON "audio_diagnostics" FOR EACH ROW EXECUTE FUNCTION "audio_forbid_update"();--> statement-breakpoint
CREATE TRIGGER "audio_diagnostic_flags_immutable" BEFORE UPDATE ON "audio_diagnostic_flags" FOR EACH ROW EXECUTE FUNCTION "audio_forbid_update"();
