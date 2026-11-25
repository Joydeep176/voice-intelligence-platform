# Phase 2B · audio processing foundation — completion record

> **Current status (2026-11-26): Phase 2B and Phase 2C were formally accepted by the user on 2026-11-26.** See
> `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` §0. The text below is the historical record from before acceptance.

> **Superseded for current status (2026-11-25):** see `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` and `PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md` (real-provider validation, ADR-0036/0037/0041). This record is kept as history.

Status: **implementation complete and validated; awaiting the user's review and explicit acceptance.** Not accepted.
Not production-ready (OD-23c, OD-48, OD-09b and others remain Open). Nothing committed. Base commit `b407c38`.
Implemented 2026-11-21; closure pass 2026-11-22. **This is the authoritative Phase 2B record**; current project state:
`docs/PROJECT_STATUS.md`. Historical: `PHASE2B_PLAN_DRAFT.md` (revision 4), `PHASE2B_SCOPE.md` (original scope),
`PHASE2B_PROGRESS.md` (archived working log).

## 1. What was built

| Area | Implementation | Evidence |
| --- | --- | --- |
| Audio service | Contract v2 (`/v1/capabilities`, `/v1/tasks` submit/status/cancel, handshake), bearer auth, bounded in-memory executor with idempotency keys and an overall task deadline, storage backend (key validation, descriptor-relative walking, atomic publish with manifest, verified reuse) | `services/audio/VERIFICATION_WS1.md` |
| Untrusted media | fd-only FFmpeg input (`-fd N -i fd:`), protocol/format/codec allow-lists, drefs off, bounded probing, clean child env, process-group kill, rlimits (`RLIMIT_FSIZE=0`), Landlock (filesystem, TCP, signal and abstract-socket scoping; `required` in Compose), stderr never logged, signal-killed children mapped to `RESOURCE_EXHAUSTED`/`TIMEOUT` | `VERIFICATION_WS1/WS3/REMEDIATION.md` |
| Probe and decode | Magic-byte demuxer selection, limits (interim OD-10), trial decode, streamed native and canonical passes | `VERIFICATION_WS3.md` |
| Timeline | Four timelines (source, decoded, canonical, segments); mapping record with `exact / offset_applied / approximate / uncertain` and error bound | `docs/development/phase2b-timestamps/` |
| Measurements | RMS, peak, crest, DC, clipping (counts, runs), inter-channel correlation, silence ratio, noise-floor estimate, level series, EBU R128; each quantity labelled measured / derived / estimate; unavailable ones listed with reason; no judgements (ADR-0019) | `VERIFICATION_WS4.md` |
| Canonical derivative | Mono 16 kHz s16 WAV, SHA-256, duration = sample count; original never modified | E2E scenario 2, 9 |
| Segmentation | VAD-agnostic segmenter (interim OD-10 parameters); **no VAD registered** (OD-29) | `services/audio/tests/test_segmentation_*` |
| Database | Migration `0002_audio_processing`: `audio_preprocessings`, `audio_segments`, `audio_measurements`, `recordings.media_probe`, composite workspace FKs, lifecycle CHECKs, immutability triggers; applied to the dev DB after backup | `DATABASE_DESIGN.md` §4 |
| Orchestrator | `audio-probe`, `audio-preprocess` step-jobs, `audio-sweep`; bounded retries; Node backstop deadline (counted from first `running`); cancel; lost-task re-attach | `apps/orchestrator/src/processing/` |
| API | `GET/POST /recordings/{id}/processing`, `POST .../cancel`, `GET .../segments`; probe automatic for new uploads only; preprocessing only on explicit request | `API_SPECIFICATION.md` §3a |
| Frontend | Recording detail "Audio processing" card: real states, persisted progress only, no verdicts, polling only while active | `docs/design/phase2b-processing-ui/README.md` |

## 2. Test results

Rows are from the consolidated run of 2026-11-21 (after all remediation) unless marked as the 2026-11-22 closure pass.

| Suite | Result |
| --- | --- |
| `pnpm build`, `pnpm lint`, `pnpm typecheck` | pass (all tasks) |
| Contracts (Vitest) | 138 passed |
| Database unit / integration | 5 / 34 passed |
| API unit / integration (Jest) | 195 / 39 passed |
| Orchestrator unit / integration | 39 / 42 passed |
| Web unit (Vitest) | 204 passed |
| Python host (`pnpm audio:test`) | 690 passed, 233 skipped (container-only tests, by marker) |
| Python container (`pnpm audio:test:container`) | 911 passed, 12 skipped (9 need `AUDIO_SERVICE_TEST_DOCKER`, `/storage` absent, long-file dir, one test for kernels without Landlock) |
| Compose hardening (`AUDIO_SERVICE_TEST_DOCKER=1`) | 9 passed |
| Real-stack E2E (`pnpm test:phase2b:e2e`) | 10/10 scenarios passed (also 3/3 runs before remediation) |
| Web Playwright, full suite (closure pass 2026-11-22) | **95 passed, 0 failed, 11 skipped** (106 tests; desktop and mobile projects). Isolated: `vip_test`, scratch storage, Redis DB 13; dev DB count 27 before and after. 10 skips are project-specific by design (desktop-only or mobile-only tests); 1 skip is the desktop navigation journey, which skips when the dev workspace has no recordings, as in the freshly seeded test DB at that moment |
| Web Playwright, `navigation.spec.ts` desktop only (closure pass 2026-11-22, separate run) | **5 passed** of 5, including the navigation journey, once the isolated DB held recordings. This is a separate run, not part of the full-suite counts above |
| Web Playwright, full suite (consolidated run 2026-11-21, dev DB) | 95 passed, 1 failed, 10 skipped. The failure was a Phase 2A locator made ambiguous by the new card's "Not started" text; fixed by a stricter locator plus a separate card check (not a loosening) |
| Bundle budgets | all met (render-critical `/recordings` 172.7 KB / 175 KB after marking `@vip/contracts` side-effect free) |
| Audio lint (ruff, format, mypy strict) | pass |

`pnpm format:check` fails on 89 files, all pre-existing tooling files (`.agents/` 85, `.codex/` 3, `AGENTS.md` 1); verified on 2026-11-22 that none is a Phase 2B changed or new path. Closure pass also re-ran build, lint, typecheck (all tasks pass) and bundle budgets (all met).

## 3. Resource results (M1 8 GB, Docker Desktop 4.99.0, container 512 MB / 1 CPU)

4 h stereo 48 kHz FLAC: 288 s wall (RTF 0.020), anon peak 100 MB, cgroup `memory.peak` 512 MB (page cache), FFmpeg
peak 57 MB, temp peak 441 MB, succeeded. Five consecutive 30 min jobs: anon growth −1.1 %. Every case is below 384 MB
by anonymous memory. Full table: `docs/development/phase2b-resources/README.md`.

## 4. VAD benchmark (synthetic TTS corpus; preliminary)

Silero (ONNX) F1 0.945 / 0.942 at 10 / 5 dB, FPR 0.057, RTF 0.017, anon 52 MiB — meets every plan §13.4 criterion.
WebRTC and the NumPy baseline each fail at least one. **No VAD is selected or installed in the runtime.**
`docs/development/phase2b-vad-benchmark/README.md`.

## 5. Reviews

Architecture (Opus): no open decision resolved in code; boundaries hold; documentation findings fixed. Security and
data-integrity (Opus): 0 critical/high; 3 medium and 8 low findings, all remediated with tests (signal-killed
children, task deadlines, Landlock `required`/scoping/`PR_SET_DUMPABLE`, body cap, rmtree TOCTOU, readiness, sweeper
re-attach, retry row, explicit start behind a probe, storage URI). One further defect found by Opus review of the fix
(queued tasks could hit the Node backstop) was fixed.

## 6. Residual risks (documented, not mitigated)

- Development container egress is possible (ADR-0035); an exploited FFmpeg child can still use UDP.
- `mjpeg`/`png` decoders are opened for attached cover art during stream-info probing (contained by Landlock,
  rlimits, `-max_alloc`, cgroup).
- On kernels without Landlock the service refuses media children (`required`); a host `uv run` has no sandbox.
- Truncation of MP3 without Xing/LAME and of Ogg is undetectable from the file; dropped-frame silence without a
  timestamp jump is not listed in `gaps`.
- Bit-identical floating-point measurements across CPU architectures are not claimed.
- `derived/` deletion is not implemented (no recording-deletion endpoint exists yet; SEC-6 must include it).

## 7. Prototype findings for ADR-0002 / ADR-0018 / ADR-0023 (for the user; statuses unchanged)

Node↔Python over HTTP with step-job polling worked end to end, including restart recovery and back-pressure.
Progress uses DB snapshot polling (ADR-0018's polling fallback); `QueueEvents`/SSE (OD-16) were not needed. FastAPI
stayed confined to the adapter. Whether these confirm the provisional ADRs is the user's decision.

## 8. Data safety

Verified 2026-11-22. Dev database: **27 recordings**.
- **23 pre-Phase-2B recordings** (22 with `e2e-synthetic-*` filenames from earlier E2E runs, 1 other). The backup
  restored into a scratch database (dropped afterwards) reproduces the recorded fingerprint `01bba1ec…`; **22 of the 23
  rows are identical** now (`4441b69d…` on both sides, comparing the pre-migration columns).
- **The 23rd, `04adac16…`**, was validated and preprocessed through an explicit processing request on 2026-11-21
  17:12 UTC, shortly after the user brought the stack up. None of the commands Claude ran in these sessions called the
  dev processing API. Gap found: processing **requests** are not audited (only completions), so the actor is not recorded.
  - *Unchanged — identity and file integrity:* workspace, original filename, storage URI, recorded SHA-256, MIME type,
    size and created_at (hash of these fields identical before and after). Processing never writes the original: the
    audio service mounts `recordings/` read-only and writes only under `derived/`, and the real-stack E2E (scenario 9)
    verified originals' SHA-256 unchanged after processing. Claude did not re-hash this recording's file on disk (reads of
    local recording storage are denied by project settings); the integrity statement rests on the unchanged recorded
    SHA-256 and the read-only design.
  - *Changed — processing metadata:* `status` `uploaded` → `valid`, `duration_ms`, `sample_rate` (22 050 Hz),
    `channels` (1), `media_probe`; one `audio_preprocessings` row (`succeeded`) with its measurements, and derived files
    under `derived/<workspace>/<recording>/<configHash>/`.
- **4 synthetic recordings** added 2026-11-21 16:55–16:58 UTC by the Phase 2A web Playwright suite against the dev API
  (two in the consolidated run; two when a re-run reused a dev API already on port 3000): `7045a0e5…`, `b4e671e2…`,
  `e24cd8db…`, `9ef50ed2…`; all now `valid` (auto-probed as new uploads); `9ef50ed2…` was also preprocessed on request.
  Kept, not deleted.
- 2 `audio_preprocessings` rows (both `succeeded`). Backup: `.local-backups/pre-0002-*.dump`.
- Environment (only what Claude did or observed):
  - `.env`: gitignored and untracked. **Claude did not read, print or modify it.** The user reported adding `AUDIO_SERVICE_TOKEN`
    to it on 2026-11-21 (Claude had suggested a command that copies the line from `.env.example`; which method the user
    used was not confirmed).
    Its current contents were not inspected; the healthy audio container returning 401 without a token indicates that a
    valid token (≥ 32 characters) is configured.
  - `.env.example`: Claude edited it during Phase 2B (variable names, comments and empty values only). On 2026-11-21
    Claude observed that `AUDIO_SERVICE_TOKEN` there held a 64-character value (length checked, value never displayed);
    after the user confirmed the setup worked, Claude reset it to `AUDIO_SERVICE_TOKEN=` (empty). No commit contains that
    value. `MEDIA_URL_SIGNING_SECRET` there is a committed placeholder from Phase 2A, not a real secret.

## 9. Decisions for the user

1. Accept Phase 2B, and formally accept the D-2B decisions implemented under the execution brief (D-2B-01, -02, -04
   to -07, -09, -12, -15, -16) → ADRs / register rows.
2. OD-10 limits and timeouts (interim: 4 h, 8 ch, 192 kHz; segmentation 1–30 s etc.; deadline 120 s + 0.5 × duration),
   including whether code-level interim constants are acceptable meanwhile.
3. D-2B-20 memory gate: anonymous memory (recommended by the evidence) vs `memory.peak`.
4. OD-29 VAD selection (benchmark ready); OD-18 / D-2B-14 datasets for a real-speech benchmark.
5. OD-39 waveform peaks; lossy timestamp target (±10 ms); librosa deferral; the four synthetic dev recordings
   (keep or remove); ADR-0002/0018/0023 prototype outcome.

## 10. Operating it

Add `AUDIO_SERVICE_TOKEN` (≥ 32 chars, `openssl rand -hex 32`) to `.env`; run the audio service in Docker
(`docker compose -f infra/docker/compose.yaml --env-file .env --profile audio up -d --build audio-service`); start API,
orchestrator and web as in `docs/development/SETUP.md`. Host `pnpm audio:dev` has no FFmpeg or Landlock and cannot
process media.

## 11. Outstanding defects and gaps (closure pass)

- Processing requests are not written to `audit_events` (only completions/time-outs): the actor of a start, retry or
  cancel is not recorded. Not fixed (closure pass adds no features); for the user to prioritise.
- `pnpm test:e2e` (Phase 2A web suite) targets the dev API/DB and reuses any server on ports 3000/5173; isolated runs need
  the wrapper approach used in the closure pass. Not changed (Phase 2A test infrastructure).
- Lossy-format truncation detection and dropped-frame gap listing limits (§6) remain.

## 12. Next steps

The user reviews the §9 decisions and §11 defects. Phase 2C is not scoped or approved and has not been started. The
working tree is preserved as is (uncommitted).
