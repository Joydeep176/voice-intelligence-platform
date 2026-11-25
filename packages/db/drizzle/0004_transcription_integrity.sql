-- Phase 2C audit §11.4 (transcript history integrity). Additive: two triggers and one function;
-- no table, column, constraint or row changes. drizzle-kit cannot express triggers, so the
-- snapshot is unchanged (generated with `drizzle-kit generate --custom`).
--
-- 1. Speakers. `transcript_segments.speaker_id` stays ON DELETE CASCADE: a NO ACTION/RESTRICT FK
--    would be checked part-way through the transcript cascade (speakers before segments) and break
--    recording deletion. Instead a direct DELETE of a speaker is refused, so it can never delete the
--    segments of an immutable version. Deletes that arrive through a foreign-key cascade (recording
--    -> run -> transcript -> speakers) run inside the FK's own trigger, so pg_trigger_depth() is
--    greater than 1 here and they stay allowed.
CREATE FUNCTION "speakers_forbid_direct_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF pg_trigger_depth() <= 1 THEN
		RAISE EXCEPTION 'speakers rows are deleted only with their transcript' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "speakers_no_direct_delete" BEFORE DELETE ON "speakers" FOR EACH ROW EXECUTE FUNCTION "speakers_forbid_direct_delete"();
--> statement-breakpoint
-- 2. Transcription uncertainties belong to an immutable transcript version (ADR-0007): UPDATE is
--    blocked like raw outputs, versions and segments. DELETE (cascade) stays allowed.
CREATE TRIGGER "transcription_uncertainties_immutable" BEFORE UPDATE ON "transcription_uncertainties" FOR EACH ROW EXECUTE FUNCTION "transcription_forbid_update"();
