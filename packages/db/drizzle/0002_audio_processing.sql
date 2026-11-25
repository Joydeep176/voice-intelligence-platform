CREATE TYPE "public"."preprocessing_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "audio_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preprocessing_id" uuid NOT NULL,
	"segment_id" uuid,
	"source" text NOT NULL,
	"schema_version" text NOT NULL,
	"measurements" jsonb NOT NULL,
	"series_uri" text,
	"service_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_measurements_source_valid" CHECK ("audio_measurements"."source" IN ('original_decoded', 'canonical')),
	CONSTRAINT "audio_measurements_object" CHECK (jsonb_typeof("audio_measurements"."measurements") = 'object')
);
--> statement-breakpoint
CREATE TABLE "audio_preprocessings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"config_hash" text NOT NULL,
	"hash_algorithm" text DEFAULT 'sha256' NOT NULL,
	"config" jsonb NOT NULL,
	"tool_versions" jsonb NOT NULL,
	"status" "preprocessing_status" DEFAULT 'queued' NOT NULL,
	"progress" jsonb,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"cancel_requested_at" timestamp with time zone,
	"normalized_uri" text,
	"canonical_sha256" text,
	"canonical_duration_ms" bigint,
	"vad" jsonb,
	"timeline" jsonb,
	"artifacts" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_preprocessings_config_hash_hex" CHECK ("audio_preprocessings"."config_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_preprocessings_canonical_sha256_hex" CHECK ("audio_preprocessings"."canonical_sha256" IS NULL OR "audio_preprocessings"."canonical_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_preprocessings_attempt_nonnegative" CHECK ("audio_preprocessings"."attempt" >= 0),
	CONSTRAINT "audio_preprocessings_canonical_duration_nonnegative" CHECK ("audio_preprocessings"."canonical_duration_ms" IS NULL OR "audio_preprocessings"."canonical_duration_ms" >= 0),
	CONSTRAINT "audio_preprocessings_timeline_object" CHECK ("audio_preprocessings"."timeline" IS NULL OR jsonb_typeof("audio_preprocessings"."timeline") = 'object'),
	CONSTRAINT "audio_preprocessings_error_object" CHECK ("audio_preprocessings"."error" IS NULL OR jsonb_typeof("audio_preprocessings"."error") = 'object'),
	CONSTRAINT "audio_preprocessings_started_finished_order" CHECK ("audio_preprocessings"."finished_at" IS NULL OR "audio_preprocessings"."started_at" IS NULL OR "audio_preprocessings"."finished_at" >= "audio_preprocessings"."started_at"),
	CONSTRAINT "audio_preprocessings_succeeded_complete" CHECK ("audio_preprocessings"."status" <> 'succeeded' OR ("audio_preprocessings"."finished_at" IS NOT NULL AND "audio_preprocessings"."canonical_sha256" IS NOT NULL AND "audio_preprocessings"."normalized_uri" IS NOT NULL AND "audio_preprocessings"."canonical_duration_ms" IS NOT NULL AND "audio_preprocessings"."timeline" IS NOT NULL)),
	CONSTRAINT "audio_preprocessings_failed_has_error" CHECK ("audio_preprocessings"."status" <> 'failed' OR "audio_preprocessings"."error" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "audio_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preprocessing_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"overlap_start_ms" integer DEFAULT 0 NOT NULL,
	"overlap_end_ms" integer DEFAULT 0 NOT NULL,
	"speech_ms" bigint NOT NULL,
	"contains_synthetic_gap" boolean DEFAULT false NOT NULL,
	"storage_uri" text,
	CONSTRAINT "audio_segments_index_nonnegative" CHECK ("audio_segments"."index" >= 0),
	CONSTRAINT "audio_segments_range_valid" CHECK ("audio_segments"."start_ms" >= 0 AND "audio_segments"."start_ms" < "audio_segments"."end_ms"),
	CONSTRAINT "audio_segments_overlap_nonnegative" CHECK ("audio_segments"."overlap_start_ms" >= 0 AND "audio_segments"."overlap_end_ms" >= 0),
	CONSTRAINT "audio_segments_speech_nonnegative" CHECK ("audio_segments"."speech_ms" >= 0),
	CONSTRAINT "audio_segments_speech_within_range" CHECK ("audio_segments"."speech_ms" <= "audio_segments"."end_ms" - "audio_segments"."start_ms")
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "media_probe" jsonb;--> statement-breakpoint
-- Composite FK targets must exist before the FKs that reference them (hand-ordered).
CREATE UNIQUE INDEX "audio_preprocessings_id_workspace_uq" ON "audio_preprocessings" USING btree ("id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_segments_id_preprocessing_uq" ON "audio_segments" USING btree ("id","preprocessing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_id_workspace_uq" ON "recordings" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "audio_measurements" ADD CONSTRAINT "audio_measurements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_measurements" ADD CONSTRAINT "audio_measurements_preprocessing_workspace_fk" FOREIGN KEY ("preprocessing_id","workspace_id") REFERENCES "public"."audio_preprocessings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_measurements" ADD CONSTRAINT "audio_measurements_segment_preprocessing_fk" FOREIGN KEY ("segment_id","preprocessing_id") REFERENCES "public"."audio_segments"("id","preprocessing_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_preprocessings" ADD CONSTRAINT "audio_preprocessings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_preprocessings" ADD CONSTRAINT "audio_preprocessings_recording_workspace_fk" FOREIGN KEY ("recording_id","workspace_id") REFERENCES "public"."recordings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_segments" ADD CONSTRAINT "audio_segments_preprocessing_workspace_fk" FOREIGN KEY ("preprocessing_id","workspace_id") REFERENCES "public"."audio_preprocessings"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurements_whole_uq" ON "audio_measurements" USING btree ("preprocessing_id","source") WHERE "audio_measurements"."segment_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_measurements_segment_uq" ON "audio_measurements" USING btree ("preprocessing_id","segment_id","source") WHERE "audio_measurements"."segment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audio_measurements_preprocessing_idx" ON "audio_measurements" USING btree ("preprocessing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_preprocessings_recording_config_uq" ON "audio_preprocessings" USING btree ("recording_id","config_hash");--> statement-breakpoint
CREATE INDEX "audio_preprocessings_workspace_recording_created_idx" ON "audio_preprocessings" USING btree ("workspace_id","recording_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "audio_segments_preprocessing_index_uq" ON "audio_segments" USING btree ("preprocessing_id","index");--> statement-breakpoint
CREATE INDEX "audio_segments_preprocessing_start_idx" ON "audio_segments" USING btree ("preprocessing_id","start_ms");--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_media_probe_object" CHECK ("recordings"."media_probe" IS NULL OR jsonb_typeof("recordings"."media_probe") = 'object');--> statement-breakpoint
-- Immutability (ADR-0007 spirit, plan §12). drizzle-kit cannot express triggers, so they are
-- appended by hand; the snapshot is unaffected. DELETE (cascade from a recording) stays allowed.
CREATE FUNCTION "audio_forbid_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% rows are immutable after insert', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audio_segments_immutable" BEFORE UPDATE ON "audio_segments" FOR EACH ROW EXECUTE FUNCTION "audio_forbid_update"();--> statement-breakpoint
CREATE TRIGGER "audio_measurements_immutable" BEFORE UPDATE ON "audio_measurements" FOR EACH ROW EXECUTE FUNCTION "audio_forbid_update"();
