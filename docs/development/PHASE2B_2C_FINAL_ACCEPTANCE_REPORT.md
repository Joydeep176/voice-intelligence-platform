# Phase 2B / 2C: final acceptance report

## 0. Formal acceptance (2026-11-26)

**The user formally accepted Phase 2B (Audio Processing Foundation) and Phase 2C (Transcription and Diarization
Foundation), effective 26 November 2026.** Recorded in PROJECT_STATUS, CLAUDE.md, ADR-0040, ADR-0041, the completion
records, the matrix, the checkpoint and the journal.

**Decided with the acceptance:**
- **ADR-0041** (2 CPUs / 2 inference threads) is confirmed **Accepted**.
- **The dense-speech limitation is temporarily accepted.** The configuration is unchanged: CPU 2, memory 768 MiB,
  30 s windows, 1 s overlap, 240 s deadline.
  - A window with more than about 7–8 speech spans exceeds the deadline.
  - The constructed 14-span window failed `AUDIO_TIMEOUT` after 3 attempts (§5, §7).
  - This is an accepted limitation, **not** a passing performance test.

**Still open after acceptance.** Acceptance does not mean every requirement passed or every issue is resolved:
- **NFR-3 / NFR-4 accuracy thresholds: TBD.** ADR-0042 stays **Proposed, awaiting the user's decision**. The measured
  synthetic results are preserved, and accuracy is not marked passed. No deferral decision is attributed to the user.
- **Not tested:**
  - the `pnpm test:phase2b:e2e` re-run;
  - the Graphify refresh;
  - transcription of a recording over 2 h.
- **Known limitations and follow-up engineering** (§10):
  - word repetition in window overlaps;
  - diarization over-clustering;
  - Hinglish in Devanagari with `en`/`hi` labels only;
  - abandoned audio-task cleanup (no cancel on give-up);
  - deterministic timeouts retried;
  - fail-closed crash on a failed inference self-test.

**Next milestone:** Phase 3A, **planning only**. Nothing is implemented until the user approves its scope, requirements,
architecture, acceptance criteria and plan.

The sections below are the pre-acceptance report, as reviewed by the user. Wording such as "awaiting the user's decision"
in §1–§11 describes the state before 2026-11-26.

## 1. Executive summary

Phase 2B (audio processing) and Phase 2C (transcription and diarization with the self-hosted providers) are
implemented, integrated and validated end to end on the real stack.

**Validated with the real providers:**
- A browser drives the whole flow: upload, validation, preprocessing, whisper.cpp transcription with Silero spans and
  per-span `en`/`hi`, and sherpa-onnx diarization.
- The transcript persists and is retrieved again after a reload.
- Workspace isolation holds.
- The UI tracks the backend states.

**Failure paths tested:** invalid and unsupported media, duplicate submission, cancel, retry, an audio-service outage
with recovery, and a deadline timeout on fragmented speech.

**Fixed during closure:**
- B-1 (STT too slow for the deadline): ADR-0041, 2 CPUs.
- A duplicate-task pile-up after an outage.
- Three UI truthfulness defects.
- A benchmark report crash.

**Open, for the user:**
- (1) The accuracy thresholds NFR-3 and NFR-4 are **undecided**. A deferral is **proposed** in ADR-0042, awaiting the
  user's decision. The measured baseline is preserved; accuracy is **not** marked passed.
- (2) **Dense, fragmented speech can exceed the 240 s window deadline.** That is a product-level trade-off (§7).
- Plus the standing production items (auth, retention, deployment target), which are outside 2B/2C.

**Recommendation:** both phases are technically complete and ready for the user's acceptance decision. What still
needs explicit approval: the NFR-3/NFR-4 thresholds (deferral proposed in ADR-0042), ADR-0041 final status, the
dense-speech limitation, the three outstanding validation activities, and the acceptance itself (§11).

## 2. Implementation changes in this closure session (2026-11-25)

| Change | Files | Tests |
| --- | --- | --- |
| **B-1:** audio service 1 → 2 CPUs and inference threads 1 → 2 (user decision, ADR-0041); memory, model, deadline and per-span detection unchanged | `infra/docker/compose.yaml`; ADR-0041; ADR-0039 amended; HLD OD-10; DEPLOYMENT; SRS NFR-2; `isolation.py` (comment) | Container suite; Compose hardening; real check |
| Rejected and reverted: decode `audio_ctx` sized to the span (failed the E7 accuracy gate) | `transcribe.py` restored to identical with the image | E7 |
| **Defect:** after an outage, each orchestrator retry queued a duplicate inference task (fresh random idempotency key per call). The duplicates blocked the single-slot service for about 7 min | `apps/orchestrator/src/providers/audio-task.ts`: key derived from the task content; an earlier failed or cancelled task gets a suffixed key, so a retry never replays a failure | `self-hosted.spec.ts` (+3 tests; the old "fresh key per call" test was replaced because it encoded the defect); outage E2E re-run |
| **UI defect:** the "Processing status" panel said "analysis pipeline is not available in this build" and showed preprocessing and transcription as "Not available yet" after both completed | `components/processing-status.tsx`, `pages/recording-detail.tsx` | `processing-status.test.tsx` (5 new) |
| **UI defect:** audio-service failures were shown as "failed for an unknown reason" | `components/transcription/model.ts` (`AUDIO_*` messages plus a named fallback) | `model.test.ts` (3 new) |
| **UI defect:** "Ingestion and upload: Pending" while the recording was validating | `processing-status.tsx` (`uploadCompleted`) | `processing-status.test.tsx` |
| **UI copy:** stale "Phase 1 foundation · analysis pipeline not yet available" sidebar note; "no voice activity detection configured", which was untrue because Silero runs inside the windows | `app-shell.tsx`, `transcription/model.ts` | `App.test.tsx` and `transcript-section.test.tsx` assertions updated to the corrected copy |
| **Tooling:** `run.py report` crashed on a partial cpp-medium pass a; the determinism check now compares only clips present in both passes | `benchmarks/stt/sttbench/report.py` | `test_metrics.py` 5/5; report regenerated |
| **Tests:** Compose hardening assertions were stale. They expected 512 MB / 1 CPU and no `/models`; they now expect exactly 768 MB / 2 CPUs and `/models` read-only (not weakened) | `tests/test_compose_hardening.py` | 9/9 |
| ADRs written: ADR-0036 (STT), ADR-0037 (diarization), ADR-0041 | `docs/architecture/adr/` | — |

## 3. Multi-agent contributions

- **One supporting agent:** `security-reviewer` (Opus, read-only), reviewing the sandbox, infrastructure and this
  session's changes.
  - It found 0 blocking and 4 non-blocking issues, all pre-existing.
  - I checked each against the code. Finding 1 (an abandoned audio task is never cancelled) was then reproduced live
    in the outage test and fixed for the duplicate-queueing part (§2). The rest are in §10.
- No other agents were used. All other work was done and checked by the lead.

## 4. Browser end-to-end with the real providers

**Setup:** headless Chromium against the running web (:5173) → API (:3000) → the user's orchestrator
(`STT_PROVIDER=whisper-cpp`, `DIARIZATION_PROVIDER=sherpa-onnx`) → audio service (768 MB, 2 CPUs, Landlock enforced).

**Evidence:** `docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25/` (scripts and numbers-only
results).

| Check | 90 s English/Hindi conversation | 33 s Hinglish (6 C3 clips) |
| --- | --- | --- |
| Upload → validation → preprocessing | succeeded; `valid`, 90,000 ms | succeeded; 32,730 ms |
| Providers in the run snapshot | `whisper-cpp` / `ggml-small-q5_1`, `sherpa-onnx` / pyannote-seg-3.0 + CAM++, `fake: false` | same |
| Windows | 4 fixed windows (30 s / 1 s overlap) | 2 |
| Transcription stage | 7 min 17 s; progress 25 → 50 → 75 → 100 % shown in the UI | 3 min 53 s |
| Diarization stage | 50 s | 15 s |
| Segments (UI = API) | 17: 15 `en`, 2 `hi` (Devanagari) | 7, all `hi` (Devanagari) |
| Speakers / uncertainty markers | 4 / 2 overlapping speech, 1 speaker uncertain | 3 / 0 |
| UI reached the terminal state without a reload | yes | yes |
| Persisted (full reload) | 17 segments, Completed | 7 segments, Completed |
| Another workspace (run, recording) | 404 / 404 | 404 / 404 |
| Browser console errors | 0 | 0 |

- **Downstream intelligence and reporting:** not part of Phase 2B/2C. These are the agent phase, which is not
  approved, so they are not applicable.
- **Seen in the transcript:** words in the 1 s window overlap can appear twice (segment-level stitching, §10).

## 5. Failure paths, retry and cancellation

All runs were through the browser on the real stack.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Corrupt media (garbage bytes as `.wav`) | **Passed.** Rejected automatically after upload (`CORRUPT_MEDIA`). The UI shows "file appears to be damaged". No transcription offered; `POST /runs` → 409 | `fail-invalid.json` |
| Unsupported media (9-channel WAV) | **Passed.** `RESOURCE_LIMIT_EXCEEDED`, with the UI reason "exceeds a processing limit"; 409 on start | `fail-unsupported.json` |
| Duplicate submission | **Passed.** 3 concurrent `POST /runs` → three 202s, **one** run; a repeat while active returns the same run; an unknown field → 422; the run completed | `fail-duplicate.json` |
| Cancel mid-run, then retry | **Passed.** `running → cancelling` (the in-flight window finishes and is kept) `→ cancelled`, no transcript (404); UI shows "cancelled" plus Retry. The retry resumed at 50 % with the 2 stored windows **reused**, then completed: 17 segments, 268 s against about 520 s for a full run | `fail-cancel-retry.json` |
| Audio-service outage (container paused 60 s mid-run) | **Passed after the fix.** The run failed with `AUDIO_UNAVAILABLE` after the bounded automatic attempts. The UI now says "The audio service could not be reached. Retry once it is available again". Retry after recovery → completed. Service tasks for 2 windows: 3 transcribe, against a pile-up of duplicates before the fix | `fail-outage.json` |
| Dense speech (13 utterances, 0.45 s pauses) | **Passed.** The VAD padding merged them into 2 spans; completed in 60 s | `fail-dense.json` |
| Fragmented speech (16 utterances, 0.8 s pauses → 14 spans) | **Deadline exceeded: a known limitation, temporarily accepted 2026-11-26, not a passing performance result.** The failure handling was correct. Each of the 3 automatic attempts ran a fresh task (distinct keys, no duplicates), about 245 s apiece, and hit the deadline. The run failed `AUDIO_TIMEOUT` after 9.6 min. UI: "A transcription window took longer than its processing deadline. Retry is possible. 3 of 3 retries left." Preprocessing stays Completed | `fail-fragmented.json` |
| Worker restart mid-run (unplanned: `pnpm build` reloaded the dev orchestrator and API about 1 min into the fragmented run) | **Passed.** The run continued; attempts 2 and 3 were scheduled after the reload; no lost or duplicated work | service task log (3 tasks, 18:09–18:21 UTC) |

Covered by the integration suites (re-run in §12):
- retry after an injected failure with stored windows reused;
- transient retry by the queue; attempts exhausted;
- provider timeout; run deadline;
- three sweeper recoveries (stalled jobs);
- idempotent and concurrent submission;
- workspace isolation on every read.

## 6. C3 benchmark and accuracy

**Report:** `docs/development/phase2c-stt-benchmark/README.md` and `results-tables.md`, regenerated 2026-11-25.
- Configuration and model hashes are in `results.json` and the README.
- Host: Apple M1 8 GB, Docker Desktop VM 3.8 GiB / 8 CPUs.
- Corpus: synthetic TTS, seed 20261122.

**Thresholds: undecided.** SRS NFR-3 (WER/CER per language) and NFR-4 (DER) remain "TBD". A deferral is **proposed** in
ADR-0042, awaiting the user's decision.
Nothing here is pass or fail against a threshold. Setting them is a user decision (§11).

**Production STT path** (E7, the full-context variant: VAD spans and per-span language; 240 test clips; WER / CER %).

| Language | clean | 20 dB | 10 dB | 5 dB | all |
| --- | --- | --- | --- | --- | --- |
| English | 6.7 / 4.7 | 7.5 / 4.8 | 12.6 / 7.7 | 15.4 / 11.9 | 10.5 / 7.3 |
| Hindi | 46.9 / 23.9 | 48.8 / 22.6 | 47.8 / 23.2 | 51.2 / 24.7 | 48.7 / 23.6 |
| Hinglish | 81.2 / 82.5 | 83.6 / 82.2 | 84.5 / 81.6 | 87.0 / 85.6 | 84.1 / 83.0 |

- **Hinglish by reference script:** Devanagari-mixed references WER 52.2 %. Romanised references 108.6 %, which is
  above 100 % by construction: the output is Devanagari and no transliteration is applied.
- **Language ID** (majority per clip): English `en` 77/80 (3 without speech); Hindi `hi` 80/80; Hinglish `hi` 78, `en` 2.
- **Single-pass C3 comparison** (common clips, clean / 10 dB): whisper.cpp small English WER 3.1 / 9.2, Hindi CER
  16.8 / 20.6. whisper.cpp medium is better (English 1.5 / 3.1, Hindi CER 12.9 / 13.5) but does not fit in memory
  (anonymous 950 MiB).

**Diarization** (DER %, 250 ms collar; CAM++, the selected candidate):

| Set | Result |
| --- | --- |
| Test, dev-tuned threshold, by speaker count 2 / 3 / 4 | 14.7 / 21.4 / 6.1 |
| Test, oracle speaker count | 3.1 / 2.8 / 3.1 |
| 10 min test files, production windowing | 17.4 / 10.4 / 7.0 |
| 60 min file, production windowing | 7.7 |
| WeSpeaker (comparison), dev-tuned | 14.9 / 18.2 / 9.9; RTF 5.4 against 1.1 |

## 7. Residual risk: dense speech against the 240 s deadline

- **Cost model:** whisper.cpp cost scales with speech spans. Each span needs about 2 encoder passes, roughly 30 s per
  span at 2 CPUs including overhead (E8, real-service timings).
- **Is the span count bounded by existing inputs? No.**
  - The VAD settings bound it indirectly: speech ≥ 250 ms, silence ≥ 300 ms, 200 ms padding, which merges pauses
    under about 0.4–0.7 s.
  - Nothing caps the number of spans per window.
- **Realistic load:** E10 ran the service's own VAD over every synthetic conversation (252 windows, 2–60 min files).
  - The maximum was **7 spans per window**, in 1 window. Most windows had 4–5.
  - No window had more than 8.
  - At about 30 s per span, 7 spans take roughly 210–230 s: inside the deadline, with little margin.
- **Constructed worst case:** 16 one-second utterances with 0.8 s pauses gave 14 spans. That exceeds the deadline
  deterministically (§5).
- **Deadline enforcement:** the service kills the child at the deadline and returns `TIMEOUT` (seen at 240.8 s in the
  1-CPU real check). `AUDIO_TIMEOUT` is retryable, so a deterministic over-deadline window costs 3 × 240 s before the
  run fails. Windows already stored are kept and reused by a manual retry.
- **Handling in the UI:** safe. The UI states the cause and offers Retry, and earlier stages are kept. A retry of the same
  window fails again for the same reason; that is the product-level trade-off.
- **Mitigation options.** Each changes something the user reserved, so none is applied:
  - (a) A higher CPU limit: 4 CPUs measured 72.6 s for 5 spans.
  - (b) A deadline that scales with the span count (relaxes the 240 s rule).
  - (c) Shorter windows for dense audio (changes ADR-0039's 30 s windows).
  - (d) Merging adjacent spans above a cap (would weaken per-span code-switching; needs an accuracy gate).
- **Recommendation:** accept the risk for 2B/2C. Real conversational speech in the corpus stays at or under 7 spans,
  and failures are safe and retryable. Revisit with real recordings (OD-18). Alternatively choose (a) if the margin
  must be larger.

## 8. Security and infrastructure validation

| Control | Evidence | Status |
| --- | --- | --- |
| Landlock enforced (media and inference profiles) | Real checks: `landlockEnforced` and `inferenceLandlockEnforced` true, ABI 8, scoped; container sandbox tests | Passed |
| Model access: only `/models` readable by the inference child; storage not readable | `test_inference_sandbox_container.py` (in the container suite) | Passed |
| Read-only model volume; SHA-256 verified at startup | Compose hardening `/models: RO`; startup verification (security review) | Passed |
| Network: loopback-published port, bridge network, no TCP from children | Compose hardening 9/9; Landlock TCP rules (container suite) | Passed |
| Process isolation: child process, fixed environment without the token, process-group kill, capped stdout | Security review item 4; `test_isolation_unit.py` | Passed |
| Resource limits: 768 MB / 2 CPUs / 64 pids; rlimits | Compose hardening; 60 min run: anonymous peak 524 MiB, no OOM | Passed |
| Cancellation and deadline enforcement | Cancel E2E; TIMEOUT at the deadline (real check); integration deadline tests | Passed |
| Container hardening (read-only rootfs, cap_drop ALL, no-new-privileges, tmpfs noexec) | Compose hardening 9/9 | Passed |
| Secret handling (token never reaches children or logs; no secrets in evidence) | Security review; evidence grep for transcript text | Passed |
| Service authentication (bearer, at least 32 characters) | Readiness returns 401 without the token; API tests | Passed |
| Responsiveness under inference | 846 + 5,203 liveness probes, 0 failures | Passed |

## 9. ADR status

| ADR | Status |
| --- | --- |
| ADR-0036, STT (whisper.cpp small q5_1, per-span language) | Accepted (selection delegated, 2026-11-24). Implementation matches. NFR-3 threshold undecided (deferral proposed, ADR-0042) |
| ADR-0037, diarization (sherpa-onnx + CAM++, windowed above 10 min) | Accepted (selection delegated). Implementation and config defaults match. NFR-4 threshold undecided (deferral proposed, ADR-0042) |
| ADR-0041, 2 CPUs / 2 threads | **Accepted provisionally; final confirmation not given.** All its validation conditions passed on 2026-11-25. The dense-speech limitation is documented in its Consequences |
| ADR-0040, closure decision items | Accepted. **Corrected 2026-11-26:** it no longer claims phase acceptance |
| ADR-0042, accuracy thresholds | **Proposed**, awaiting the user's decision (corrected 2026-11-26) |
| ADR-0038 (Silero spans), ADR-0039 (limits, amended by ADR-0041) | Accepted; consistent with the implementation |

## 10. Known limitations and pre-existing findings (not fixed here)

1. **Window boundaries:** text can repeat across the 1 s window overlap (segment-level stitching; word timestamps are
   not requested).
2. **No `mixed` language label:** spans are `en` or `hi` only. Code-switch spans (FR-4.2) belong to the Transcription
   Agent (agent phase). Hinglish English words are written in Devanagari.
3. **Uncertainty kinds:** only `overlapping_speech` and `speaker_uncertain` are generated (FR-4.7). Low confidence,
   inaudible and uncertain language are not.
4. **Diarization over-clusters:** 12 speakers found for 4 on 60 min. Users can rename speakers; there is no merge.
5. **Abandoned tasks (open limitation):** an audio task abandoned at the orchestrator's provider timeout, or during a
   run cancel, is **not** cancelled on the service (security review finding 1). It runs to its own deadline on the
   single slot.
   With the new keys, a retry rejoins it instead of duplicating it. Recommended: `DELETE /v1/tasks/{id}` on
   abandonment.
6. **Outage tolerance:** a 60 s audio-service outage exhausts the 3 automatic attempts (5 / 10 s backoff); the user
   must press Retry. This is bounded per OPS-3.
7. **Retry classification:** `RESOURCE_EXHAUSTED` and `TIMEOUT` are retryable, so a deterministic failure costs up
   to 3 attempts (security review finding 3).
8. **Fail-closed crash:** in Landlock `required` mode, an inference-runner self-test failure crashes the service
   instead of reporting not-ready. It fails closed (security review finding 2).
9. **Corpus:** synthetic TTS only. Real-speech accuracy is unmeasured (OD-18).
10. **Phase 2B real-stack E2E (`pnpm test:phase2b:e2e`) was not re-run:** its harness binds port 8001, which the live
    dev audio service occupies. Its 10/10 pass is from 2026-11-21.

## 11. Closure actions (2026-11-26) and the decision package

**Done at the user's request (documentation only; no limits, windows or deadline changed):**
1. ADR-0040 corrected: no phase-acceptance claim.
2. NFR-3 / NFR-4: a deferral is **proposed** (ADR-0042, awaiting the user's decision). The SRS stays "TBD", and the
   baseline is preserved.
3. The dense-speech limitation is documented in ADR-0041 (14-span timeout evidence; 240 s deadline unchanged) and in
   §7 here.
4. The idempotency fix and the abandoned-task limitation are confirmed below.
5. Outstanding validation activities are listed below.
6. The matrix distinguishes Passed / Failed (none) / Deferred / Not tested / Blocked / N/A.
7. Runtime state is confirmed below.
8. ADR statuses are in §9.
9. Regression checks are in §12.

**Outage and idempotency fix: complete and verified.** In `audio-task.ts`, the idempotency key is derived from the task
content, and an earlier failed or cancelled task gets a suffixed key.
- Unit tests: 118 orchestrator passed, including 3 new tests.
- Re-run of the outage E2E: 3 transcribe tasks for 2 windows, no duplicates. Before the fix, duplicates blocked the
  service for about 7 min.
- The fragmented E2E confirmed that retries after a real failure run fresh tasks.

**Abandoned-task cancellation: open limitation, not fixed.** The orchestrator never sends `DELETE /v1/tasks/{id}` when
it gives up (provider timeout, run cancel).
- The task runs on until the service deadline.
- The cost is bounded: one task, at most 240 s, and a retry rejoins it instead of duplicating it.
- Recommended follow-up, not blocking.

**Outstanding validation activities: Not tested, none deferred.** Each stays outstanding until it is run or the user
explicitly defers it.

| Activity | State | Why |
| --- | --- | --- |
| `pnpm test:phase2b:e2e` re-run | Outstanding | Its harness binds port 8001, which the live dev audio service uses. It needs a window with the dev audio service stopped. Last result 10/10 (2026-11-21) |
| Graphify refresh (`graphify update .`) | Outstanding | Dev tooling only; no acceptance requirement depends on it |
| Transcription of a recording over 2 h (NFR-1 / FR-4.6) | Outstanding (Not tested) | About 8–10 h of run time at the measured RTF. 2B processing of 4 h and 2C diarization of 60 min are verified |

**Runtime state (checked 2026-11-26).**
- **Orchestrators:** two runtimes are up and **idle**: PID 1980 (since 2026-11-24) and the user's PID 40415. Both use
  the real providers, with 2 workers per queue. No active, waiting or delayed jobs on `run-transcription`,
  `audio-probe` or `audio-preprocess`; the audio service is at 0.4 % CPU. **Neither was stopped or restarted.**
  Stopping PID 1980 is safe at this moment if a single consumer is wanted. That is the user's call.
- **Synthetic recordings:** the 2026-11-25 E2E added **13** to the dev database, which now holds 42 in total. They are
  kept, per ADR-0040 item 6. Breakdown: 6 valid with a completed run; 4 rejected as invalid; 2 valid with a failed
  run (the outage first run, the fragmented timeout); 1 valid with an unstarted run.

**Needs the user's explicit approval:**
0. **NFR-3 / NFR-4 accuracy thresholds:** accept the proposed deferral (ADR-0042), or set thresholds now from the
   baseline.
1. **Final status of ADR-0041:** confirm "Accepted provisionally" as Accepted, or not.
2. **The dense-speech limitation (§7):** accept it as is, or choose a mitigation (each changes a reserved limit).
3. **The three outstanding validation activities:** run them, or defer them explicitly.
4. **Formal acceptance of Phase 2B and Phase 2C.**

## 12. Final test results (final working tree, 2026-11-25)

| Suite | Result |
| --- | --- |
| `pnpm build` / `lint` / `typecheck` (`--force`) | pass (5 / 7 / 7 tasks) |
| Contracts / DB unit / API unit / orchestrator unit / web unit | 170 / 5 / 211 / 118 / 270 passed |
| Audio host (`pytest`) / `audio:lint` (ruff, format, mypy) | 736 passed, 236 skipped (container-only) / pass |
| Audio container suite (`pnpm audio:test:container`) | 960 passed, 12 skipped (environment gates) |
| Compose hardening (`AUDIO_SERVICE_TEST_DOCKER=1`) | 9 / 9 passed |
| Benchmark metric self-checks | 5 / 5 |
| Integration (`pnpm test:integration`; `*_test` databases, Redis DB 15) | DB 57 / API 67 / orchestrator 60 passed |

The matrix is in `PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md`.
