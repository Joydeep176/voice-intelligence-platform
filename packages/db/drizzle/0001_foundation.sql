CREATE TYPE "public"."recording_status" AS ENUM('uploading', 'uploaded', 'validating', 'valid', 'invalid', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('created', 'queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."upload_session_status" AS ENUM('active', 'completed', 'expired', 'aborted');--> statement-breakpoint
CREATE TYPE "public"."upload_strategy" AS ENUM('local_chunked', 's3_multipart');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "consent_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attested_by" text NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"statement_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'created' NOT NULL,
	"current_node" text,
	"error" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_runs_retry_nonnegative" CHECK ("pipeline_runs"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"storage_uri" text NOT NULL,
	"sha256" text,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"duration_ms" bigint,
	"sample_rate" integer,
	"channels" integer,
	"status" "recording_status" DEFAULT 'uploading' NOT NULL,
	"validation_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_size_positive" CHECK ("recordings"."size_bytes" > 0),
	CONSTRAINT "recordings_sha256_hex" CHECK ("recordings"."sha256" IS NULL OR "recordings"."sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"strategy" "upload_strategy" NOT NULL,
	"part_size" integer NOT NULL,
	"total_parts" integer NOT NULL,
	"parts_received" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "upload_session_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_part_size_positive" CHECK ("upload_sessions"."part_size" > 0),
	CONSTRAINT "upload_sessions_total_parts_positive" CHECK ("upload_sessions"."total_parts" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_attestations" ADD CONSTRAINT "consent_attestations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_occurred_idx" ON "audit_events" USING btree ("workspace_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "consent_attestations_recording_uq" ON "consent_attestations" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "pipeline_runs_recording_created_idx" ON "pipeline_runs" USING btree ("recording_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pipeline_runs_workspace_idx" ON "pipeline_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "recordings_workspace_created_idx" ON "recordings" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_storage_uri_uq" ON "recordings" USING btree ("storage_uri");--> statement-breakpoint
CREATE INDEX "upload_sessions_recording_idx" ON "upload_sessions" USING btree ("recording_id");