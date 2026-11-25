# Phase 2C · completion report (transcription and diarization foundation)

> **Current status (2026-11-26): Phase 2B and Phase 2C were formally accepted by the user on 2026-11-26.** See
> `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` §0. The text below is the historical record from before acceptance.

> **Superseded for current status (2026-11-25):** see `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` and `PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md` (real-provider validation, ADR-0036/0037/0041). This record is kept as history.

Date: 2026-11-24 (updated after runtime validation the same day). Follows `PHASE2C_COMPLETION_AUDIT.md`. Nothing
committed. No ADR, OD, D-2C decision or provider selection was changed. **Phase 2C is not accepted**; acceptance is the
user's decision.

Status key: **COMPLETE** · **PARTIALLY COMPLETE** · **NOT VERIFIED** · **BLOCKED** · **NOT IMPLEMENTED**.

## Summary

| Area | Status |
| --- | --- |
| Fake-provider pipeline (C1 backend, C2 UI) | **COMPLETE.** Implemented and unit tested; integration tests pass; genuine browser end-to-end run on the dev stack passed |
| Audit defects | **COMPLETE.** Fixed and tested at unit and integration level |
| Migration `0004_transcription_integrity` | **COMPLETE.** Applied to the dev DB after a verified backup |
| C3 local STT/diarization benchmark | **PARTIALLY COMPLETE.** Two runs outstanding, results not regenerated |
| Provider selection (OD-02b / OD-03b) | Awaiting the user. The fakes stay |
| **Phase 2C overall** | **PARTIALLY COMPLETE.** The only outstanding workstream is C3; the remaining defects are minor (§7) |

## 1. Infrastructure health (2026-11-24, ~15:00 IST)

The user started the stack. I verified it without restarting, rebuilding or stopping anything.

| Component | Evidence | Status |
| --- | --- | --- |
| `vip-postgres-1` (pg 18.7) | `docker ps`: healthy, `127.0.0.1:5432` | Up |
| `vip-redis-1` | healthy, `127.0.0.1:6379` | Up |
| `vip-audio-service-1` | healthy; `GET :8001/health/live` → `ok` | Up |
| API | `GET :3000/api/v1/health` → `ok`, with postgres/redis/audio-service all `up`; `/health/ready` → `ok` | Up |
| Orchestrator | `node dist/main.js` running. Redis `CLIENT LIST` shows six BullMQ workers blocking on their queues: `run-transcription`, `run-sweep`, `audio-probe`, `audio-preprocess`, `audio-sweep`, `foundation-check`. Compiled `dist/` includes today's changes | Up |
| Web (Vite) | `GET :5173/` → 200 | Up |

No port conflicts and no connection errors. The orchestrator process started before Postgres and Redis were up; its
workers reconnected on their own once Redis was available.

## 2. Database backup and migration

1. **Before:** dev DB `vip` at migration 4 (0000–0003); 0004 not applied; only the 0003 trigger on `speakers`. Data at
   the time: 27 recordings, 27 runs (25 `created`, 2 `completed`), 2 transcripts. The existing backup predated 0003, so
   it did not contain the transcript data.
2. **Fingerprints:** `count|md5` of 10 tables (recordings, runs, preprocessings, transcripts, versions, speakers,
   segments, both raw-output tables, audit events), saved to `.local-backups/pre-0004-fingerprint.txt`.
3. **Backup:** `pg_dump -Fc` to `.local-backups/pre-0004-20261124T150407.dump` (92 KB, mode 600, gitignored).
4. **Usable:** `pg_restore -l` lists 18 table-data entries. A full restore into a scratch database `vip_restore_check`
   gave **identical fingerprints for all 10 tables**. Only that scratch database was then dropped.
5. **Target confirmed:** reading `DATABASE_URL` was denied by policy, so I checked indirectly. The API shares the root
   `.env` with `pnpm db:migrate`, and its 27 recording IDs equal `vip.recordings` exactly (`vip_test` holds 11).
6. **Applied** with the standard `pnpm db:migrate` ("Migrations applied.").
7. **Verified after:**
   - `drizzle.__drizzle_migrations` has 5 entries; the newest `created_at` (1795511865329) matches the journal's 0004
     entry.
   - Triggers `speakers_no_direct_delete` and `transcription_uncertainties_immutable` are enabled, alongside the existing
     `speakers_key_immutable`.
   - Function `speakers_forbid_direct_delete` exists.
   - **All 10 data fingerprints are unchanged** by the migration.

Nothing was reset, dropped, truncated or deleted in `vip`.

## 3. Integration test results (executed)

`pnpm test:integration`: exit 0, all three tasks force-executed (`cache: false`, no replays). Every suite is guarded to
`*_test` databases and Redis DB 15, so the running dev workers could not consume test jobs.

| Suite | Result | Recorded before |
| --- | --- | --- |
| `@vip/db` integration (Vitest, 3 files) | **57 passed, 0 skipped** (verbose run confirmed) | 54 |
| `@vip/orchestrator` integration (Jest, 3 suites) | **60 passed, 0 pending** (JSON report) | 58 |
| `@vip/api` integration (Jest, 5 suites) | **67 passed** | 67 |

The five new tests ran and passed, plus one strengthened test:

| Test | Package |
| --- | --- |
| Refuses a direct speaker DELETE, leaving the speaker and its segments intact | db |
| Deleting a run cascades through transcript, speakers, segments and uncertainties | db |
| Blocks UPDATE of transcription uncertainties | db |
| UPDATE of raw outputs is blocked (strengthened; previously asserted nothing) | db |
| Adopts a raw object a stopped attempt stored before its row instead of re-calling the provider | orchestrator |
| An out-of-range diarization turn fails the run on the diarization stage with no transcript | orchestrator |

The migration count of 5 and the recording cascade also pass. That confirms on real Postgres that the `pg_trigger_depth()`
guard blocks direct deletes and lets cascades through.

Areas covered by the passing suites:
- raw-output persistence and recovery (retry reuses stored windows, provider timeout, sweeper recoveries);
- windowing, including VAD windows, and stitching;
- diarization validation through the real coordinator;
- transcript v1 atomicity and idempotency;
- workspace isolation;
- speaker-delete restriction, uncertainty immutability, run and recording cascades.

**Caution:** run outside the package script, the DB suite silently *skips* (it needs `.env` for `TEST_DATABASE_URL`).
Only the script runs count.

Unit suites from earlier today (no code changed since): contracts 149, db 5, orchestrator 106, api 211, web 259.
Typecheck and lint pass.

## 4. Genuine end-to-end validation (executed)

A real headless Chromium drove the running dev stack, with no mocks. The scratch script lives in the session scratchpad,
not the repository. The fixture is a 75 s synthetic WAV (tones plus low noise, no speech; ADR-0004).

Path exercised: browser → web → API → Postgres → Redis/BullMQ → orchestrator → audio service (probe and preprocess with
real FFmpeg) → fake STT → fake diarization → transcript persistence → API → browser.

| Step | Result |
| --- | --- |
| Upload through the UI (consent and multipart) | Recording `aa3e95e9-11a5-4bad-9cfc-0de67c9a2468` |
| Start processing (UI) | `POST …/processing 202`; completed in ≈ 4 s (75,000 ms canonical, 16 kHz mono, no VAD) |
| Start transcription (UI) | `POST …/runs 202`; run `89448e90-bac4-46a0-aa6f-0a7e04dd7970` went `queued → running → completed` in 94 ms |
| Render | Fake-provider banner; "Fixed 30 s windows — no voice activity detection"; 8 segments, `00:00–00:10` to `01:10–01:15`; 2 speakers; 2 "Overlapping speech" markers (30.0–30.5 s and 60.0–60.5 s); no console errors |
| Speaker rename (UI) | `PATCH 200`; after a page reload the 4 segments show "Speaker B (e2e)"; `speaker_key` unchanged |
| API snapshot | Scope `[transcription, diarization]`; providers `fake` / `fake-stt-1` / `fake-diarization-1`, `fake: true`; window `fixed_windows` 30,000 / 1,000, 3 windows; both stages `completed`, attempt 1, fraction 1; retry 0/3 |
| Transcript API | v1 `machine`, 8 segments, by `system`; keyset paging (`limit=3` gives a cursor); time range 60–75 s gives the two expected segments; confidence `null` (never invented) |
| Raw output | 3 STT windows (0–30, 29–59, 58–75 s) plus 1 whole-file diarization, all `fake`; metadata only, no URIs. The coordinator now checks each hash against the stored bytes before inserting the row. Storage files were not read: the permission policy forbids reading local storage |
| Database | All rows of the run in one workspace; 8 of 8 segments have a speaker (4 each); every segment's `source_raw_output_ids` points at one of this run's STT rows; the run is linked to the succeeded preprocessing |
| Audit | `run.requested` (dev-local), `run.completed` (orchestrator), `speaker.renamed` |
| Workspace isolation | Another workspace gets 404 for the run, transcript, speakers, raw output and recording |
| Error paths (live) | Retry or cancel of a completed run: 409. Patching `speakerKey`: 422. Malformed ID: 404. Starting a run on a valid recording without a succeeded preprocessing: `409 INVALID_STATE_TRANSITION`, with run and audit counts unchanged (28 / 307) |

Failure, retry, cancel and timeout behaviour was not triggered on the live stack: the fakes don't fail on demand. Those
paths are covered by the integration suite (§3).

The dev database now additionally holds this synthetic recording and its preprocessing, run, transcript and audit rows.

## 5. Benchmark status

No benchmark jobs were launched. The status is as in `phase2c-stt-benchmark/README.md` (corrected and spot-checked
earlier today).

- **Done:** accuracy for 6 of 7 STT engines and for CAM++ diarization.
- **Recorded but not folded in:** resource and 512 MB feasibility raw results in `.local-benchmarks/`; `results.json`
  is not regenerated. Only whisper.cpp small and CAM++ completed under 512 MB, and neither processed a long file.
- **Outstanding:**
  1. Re-run whisper.cpp medium accuracy (failed 2026-11-23 when Docker stopped).
  2. Re-run the WeSpeaker diarization evaluation (failed the same way).
  3. `run.py report`.
  4. Resolve the short-file duration discrepancy (README says 3 min; raw files say 60 s).
  5. Review.

  These need Docker and several hours on the M1.
- Provider selection stays with the user.

## 6. Graphify

The graph is current: refreshed at 14:54 after the last code change, and no source file is newer.

| Nodes | Edges | Communities |
| --- | --- | --- |
| 4,743 | 13,745 | 178 |

- No import cycles.
- `validateTurns` is called by `diarize()`; `obtainRawOutput` by `transcribeWindow()` and `diarize()`.
- The UI reaches the API only through `@vip/contracts`; the API reaches the orchestrator only through `@vip/db` and the
  job contract.
- Limitations:
  - The HTTP and BullMQ hops are runtime-only and invisible to the static graph; §4 evidences them.
  - The five SQL migrations are not parsed (no SQL grammar installed).
  - Spec files often yield no symbols.
  - Graphify is structural evidence, not runtime proof.

## 7. Outstanding defects and limitations

**Found during the E2E run (low severity, not fixed):**
- Right after processing or transcription completes, the recording-level cards lag up to the page's 10 s poll: the header
  badge ("Validating"), the audio player ("upload not complete"), the duration and the sidebar "Processing status" ("Not
  started"). A reload shows `Valid`, `1:15` and `Completed`. The Processing and Transcript sections themselves are
  current.
- The timeline placeholder's "Speakers: produced by transcription and diarization (later phase)" now reads as outdated,
  because speakers exist in the transcript section.

**Before any real provider** (from the Opus review):
- Adopted raw objects carry no provider/model identity; add an envelope and refuse adoption on mismatch.
- A future deletion job must remove raw files by prefix (`runs/{workspace}/{run}/`), not by DB row.
- A table owner can bypass the triggers (`TRUNCATE`, `DISABLE TRIGGER`).

**Unchanged scope limits:**
- The fakes read no audio, so Hindi and Hinglish are not exercised.
- Only 2 of 5 uncertainty kinds are generated.
- No timestamp seek.
- One job per run; in-flight calls are not abortable; retries share one budget.
- Whole-file diarization only.
- No corrections or derivations API, no events stream, no cost tracking.
- A real adapter will need a storage reader for `audioUri`.

## 8. Exact remaining actions

1. **User:** decide on the two low-severity UI defects in §7 (fix now or defer).
2. **Benchmark:** with Docker up and the machine otherwise idle, run:
   - `uv run --directory services/audio --no-dev python benchmarks/stt/run.py stt …`, the whisper.cpp medium accuracy
     phase;
   - the WeSpeaker diarization evaluation;
   - `run.py report`.

   Then update the README and resolve the 60 s vs 3 min discrepancy. Exact phase flags: README §STATUS.
3. **User decisions:**
   - accept Phase 2B, the prerequisite;
   - accept Phase 2C, either for its fake-provider scope now or after C3;
   - D-2C-01..03, OD-10, OD-29;
   - later, OD-02b / OD-03b using the finished benchmark.
4. Before the first real adapter: the provenance envelope and prefix-based deletion (§7).

**Recommendation:** the fake-provider foundation is complete and validated end to end, and could be accepted for that
scope. Phase 2C as a whole stays **PARTIALLY COMPLETE** until C3 is finished. Do not start Phase 3 work before the
user's decisions.
