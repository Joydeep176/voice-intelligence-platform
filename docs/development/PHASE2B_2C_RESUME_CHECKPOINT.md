# Phase 2B / 2C closure: resume checkpoint

## Update 2026-11-26: Phase 2B and Phase 2C ACCEPTED by the user

**Phase 2B and 2C were formally accepted by the user, effective 2026-11-26.** ADR-0041 is confirmed Accepted. The
dense-speech limitation is temporarily accepted, with the configuration unchanged (2 CPU, 768 MiB, 30 s / 1 s, 240 s).

**Still open:**
- NFR-3 / NFR-4 thresholds: TBD (ADR-0042 Proposed).
- Not tested: `pnpm test:phase2b:e2e` re-run, Graphify refresh, transcription over 2 h.
- Known limitations and follow-ups: `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` §0 and §10.

**Next:** Phase 3A planning only, with no implementation until the user approves its scope and plan. Nothing is
committed.

Sections below are history.

## Update 2026-11-25, end of the closure session: work complete; waiting for the user's acceptance decision

**Phase 2B / 2C are NOT ACCEPTED.** All authorised closure work is done. Read
`PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` (summary, results, decisions) and
`PHASE2B_2C_REQUIREMENT_EVIDENCE_MATRIX.md`.

- **Done:**
  - B-1 closed by ADR-0041 (2 CPUs / 2 threads).
  - Real-provider browser E2E passed (90 s English/Hindi, 33 s Hinglish).
  - Failure paths passed: invalid, unsupported, duplicate, cancel/retry, outage/recovery, dense, fragmented timeout.
  - 60 min bounded-memory diarization passed (anonymous peak 524 MiB).
  - C3 report regenerated.
  - ADR-0036 and ADR-0037 written.
  - Docs reconciled: CLAUDE.md, PROJECT_STATUS, HLD, LLD, TESTING_STRATEGY, journal, C3 README, the completion
    records' superseded notes.
- **Fixed:**
  - Duplicate audio tasks after an outage (`audio-task.ts`, content-derived idempotency keys).
  - UI: the processing-status panel, audio failure messages, the upload step, stale copy.
  - `report.py` determinism crash.
  - Stale Compose hardening assertions.
- **Final suites (final tree):**
  - build, lint, typecheck: pass;
  - unit: contracts 170 / DB 5 / API 211 / orchestrator 118 / web 270;
  - integration: DB 57 / API 67 / orchestrator 60;
  - audio host 736;
  - audio container 960 (12 skipped);
  - Compose hardening 9/9.
- **User decisions pending:**
  - (1) NFR-3 / NFR-4 thresholds: **undecided**; a deferral is proposed in ADR-0042, awaiting the user's decision
    (corrected 2026-11-26);
  - (2) the dense-speech deadline risk;
  - (3) final acceptance of ADR-0041;
  - (4) ADR-0040 wording: **corrected** on 2026-11-26 (no phase-acceptance claim);
  - (5) the acceptance itself.
- **Not done:**
  - `pnpm test:phase2b:e2e` was not re-run: it binds port 8001, which the live dev audio service uses.
  - Graphify refresh.
  - Transcription of more than 2 h was not tested (about 8–10 h of run time).
- **Runtime state:**
  - The dev stack is up. The audio service runs at 2 CPUs; Low Power Mode is off.
  - Two orchestrator runtimes consume the queues: PID 1980 (older) and the user's PID 40415. Both use the real
    providers. Code edits reload them through `node --watch`.
  - **13** synthetic E2E recordings were added to the dev DB, which now holds 42 (`mixed90-*`, `hinglish33-*`,
    `fail-*`). They are kept.
  - **2026-11-26 closure actions:** see report §11. Both orchestrators were idle with no active jobs; neither was
    stopped.
- **Nothing is committed.**

## Update 2026-11-25 evening: B-1 fix decided (ADR-0041, 2 CPUs); validation in progress

Phase 2B / 2C are **NOT ACCEPTED**. B-1 has a decided fix that is not yet validated.

### Measured (E1–E9; details and logs in `phase2c-provider-validation/stt-speed-2026-11-24/`)

- **E1 (host load):** load makes runs slower (quiet 360–374 s, busy 438–451 s), not faster. **E2:** no warm-up effect.
- **E3/E4:** about 99 % of the time is the encoder.
  - The work is CPU-bound, with no page faults and no throttling.
  - **macOS Low Power Mode was on** and slowed runs about 1.7×. The user turned it off: an encoder pass went from
    44 s to 26–27 s at 1 CPU.
- **E5:** the full 4-span window at 1 CPU took 213–221 s, borderline.
- **E6:** decoding with `audio_ctx` sized to the span was fast on one span. Flash attention gave no gain.
- **whisper.cpp 1.8.5 quirk:** language detection uses the `audio_ctx` left by the previous call.
- **E7 (accuracy gate, 240 C3 clips): sized `audio_ctx` FAILS.**
  - WER rose for English from 0.105 to 0.187, for Hindi from 0.487 to 0.895, and for Hinglish from 0.841 to 1.025.
  - It was not materially faster: 1,734 s against 1,928 s.
  - The code change was reverted. `transcribe.py` is identical to the deployed image; copies are in the session
    scratchpad only.
- **E8 (CPUs; V0; 768 MB):** the 5-span en/hi window took 278.4 s at 1 CPU (fails), 143.0 s at 2, 72.6 s at 4.
  Languages were identical.
- **E9:** whisper's `n_threads=2` uses 2 CPUs even with `OMP_NUM_THREADS=1`, so the sandbox env pin is harmless.

### Decided and changed

- **User decision: 2 CPUs (ADR-0041, accepted provisionally).**
  - Compose `audio-service` changes: `cpus: '2.0'`, `AUDIO_SERVICE_INFERENCE_THREADS=2`, `OMP_NUM_THREADS=2`.
  - Unchanged: 768 MB, the model, the deadline, per-span detection.
- **Docs:** ADR-0039 decision 2 amended; HLD OD-10, DEPLOYMENT_ARCHITECTURE, SRS NFR-2 and the `isolation.py` comment
  updated.
- `audio-service` redeployed with 2 CPUs and healthy (same image `sha256:97699c52…`).

### Next

1. Done: the real-service check at 2 CPUs PASSED (windows 113.7 / 115.9 / 148.1 s; diarize 49.3 s; 0 probe failures;
   574 MiB peak). The container suite passed (960 passed / 12 skipped), and the Compose hardening suite 9/9 after updating
   two stale assertions (768 MB / 2 CPUs; the read-only `/models` mount).
2. Needs the user: restart the orchestrator with real providers for the browser e2e.
3. Then the remaining §7 items: browser e2e with real providers, C3 `run.py report` and thresholds, ADR-0036/0037,
   the requirement-to-evidence matrix, and the final report.

**Residual risk:** a 30 s window with more than about 8 speech spans would still exceed 240 s at 2 CPUs.

## Update 2026-11-25 (session 3, continued): C3 queue and idle A/B finished; native build reverted

Phase 2B / 2C are **NOT ACCEPTED**. **B-1 (STT speed) is OPEN.**

### Measured

- **C3 completion queue** (2026-11-24 20:29:43 → 2026-11-25 09:15:52; every step logged `run.py-exit=0`). The script
  ignores docker exit codes, so each step is judged by its result file, all present in `.local-benchmarks/`:

  | Step | Result file(s) | Recorded facts |
  | --- | --- | --- |
  | WeSpeaker accuracy, passes a and b | `diar-results/diar-eval-wespeaker-a.json` (12 conversations), `diar-eval-wespeaker-b.json` (6) | 3 threads, threshold 0.5 |
  | WeSpeaker resources, 3 GB, 1 CPU | `diar-results/diar-resources-wespeaker-main.json`, `completed: true` | 5 min file ×3: RTF median 5.38; 60 min file: RTF 5.94 (5.94 h wall), DER 0.171, 12 hypothesised speakers, anon peak 401 MiB |
  | WeSpeaker 512 MB feasibility | `diar-resources-wespeaker-512m.json` (`completed: true`, peak 256 MiB, RTF 5.36); `feasibility-wespeaker.json` (exit 0, `oom_killed: false`) | Replaces the invalid 2026-11-24 16:48 file |
  | cpp-medium accuracy, pass b | `stt-results/accuracy-cpp-medium-b.json` | 40 clips, 4 threads |

  The aggregate WER/DER (`run.py report`) has **not** been run. These files are not yet compared with the existing C3
  results or the selection thresholds.

- **Idle-host STT A/B** (2026-11-25 09:16–09:51). Window 30–60 s of the synthetic clip, variant V0 (current code), 1 CPU,
  768 MB, interleaved. Other containers were at 1.4 % CPU or less before every run.

  | Rep | Standard wheel (`vip-stt-wheel-probe`) | Source build `armv8.2-a+dotprod+fp16` (`vip-audio-service` at the time) |
  | --- | --- | --- |
  | 1 | 350.8 s (RTF 11.69) | 348.6 s (RTF 11.62) |
  | 2 | 350.8 s (RTF 11.69) | 339.1 s (RTF 11.30) |
  | 3 | 347.4 s (RTF 11.58) | 353.6 s (RTF 11.79) |
  | Mean | **349.7 s** | **347.1 s** |

  Languages were identical in all six runs (`en` ×4). The ranges overlap.

- **Real service check, idle host** (throwaway `vip-audio-inference-check`, source-build image, 768 MB, 1 CPU, Landlock
  `required`; 2026-11-25 09:51–10:06):
  - Landlock supported, ABI 8, **enforced**, scoped.
  - Preprocess succeeded (2.0 s).
  - **Transcribe: all three windows (0–30 s, 30–60 s, 60–90 s) failed with `TIMEOUT`** (retryable) at 240.6–240.8 s,
    with no segments. The recorded "RTF 8.02" is 240 s ÷ 30 s, not a speed measurement.
  - **Diarize succeeded:** 150.1 s, RTF 1.67, 5 speakers, 14 turns.
  - Responsiveness: 1720 `/health/live` probes, 0 failures, 0 over 1 s; p50 3.2 ms, p99 17.9 ms, max 251 ms. Status-poll
    max 151 ms.
  - Memory peak 572,444,672 B (546 MiB of 768 MiB); `oom_kill 0`.
  - Files: `phase2c-provider-validation/stt-speed-2026-11-24/real-check-idle-2026-11-25.json` and
    `ab-idle-2026-11-25.log` (numbers only).

### Interpretation (not measured directly)

- The source build gives no meaningful speed-up: a 0.7 % difference in means, within run-to-run spread.
- The earlier hypothesis that slowness was mainly host contention is **not supported**: on an idle host a 30 s window
  costs about 350 s at 1 CPU, about 46 % over the 240 s deadline. The 65 s runs on 2026-11-24 are unexplained outliers.
- The isolation, Landlock confinement, diarization, memory bound and liveness requirements are met. Transcription is
  the only failing real-provider path.

### Changed in this session (user decision 2026-11-25: revert the native build)

- `services/audio/Dockerfile`: build stage restored to the standard wheel. Removed `ARG WHISPER_CMAKE_ARGS`, the
  `build-essential patchelf` install, `UV_NO_BINARY_PACKAGE=pywhispercpp` and `CMAKE_ARGS` from `ENV`, the `patchelf
  --set-rpath '$ORIGIN'` step and its comments, and the runtime `libgomp1` declaration that came with the source build.
- `services/audio/tests/test_inference_sandbox_container.py`: removed `test_whisper_cpp_is_built_with_the_cpu_features`,
  which asserted `DOTPROD`/`FP16_VA` and only applies to the reverted build, and the now unused `platform` import.
- Unchanged: `pyproject.toml`/`uv.lock` (pywhispercpp 1.5.1; the lock's wheels are used again), the model (small
  `q5_1`), VAD, language detection, threads, the 240 s / 4× deadline and the CPU/memory limits.
- **Not done** (excluded by the user for this task): no image rebuild, redeploy, tests or benchmarks. The running
  `vip-audio-service-1` and the local `vip-audio-service` image still contain the source build until the next
  `docker compose build`.

### Proposed next experiments for B-1 (not started; each needs user approval, some an ADR)

1. An idle-host A/B at 2 and 4 CPUs/threads (the earlier 4-thread run was under load).
2. Language detection once per window instead of per span (halves encoder passes; changes language behaviour).
3. Shorter windows or a smaller/faster model (changes accuracy; ADR-0036).
4. A longer deadline multiplier (ADR-0039).

## Update 2026-11-24 23:10 IST (session 3, continued): native build implemented; its benefit NOT yet proven

- **Implemented (user-approved):**
  - `services/audio/Dockerfile` build stage builds pywhispercpp 1.5.1 from the locked sdist with `CMAKE_ARGS`
    `-DGGML_NATIVE=OFF -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16`, using `build-essential` and `patchelf` in the
    build stage only, and `$ORIGIN` rpaths.
  - The runtime declares `libgomp1`, which was already present through FFmpeg.
  - New container test `test_whisper_cpp_is_built_with_the_cpu_features`.
- **Verified:**
  - Container suite **961 passed, 0 failed**, 12 pre-existing skips.
  - Redeployed: `DOTPROD = 1`, `FP16_VA = 1`, both Landlock profiles enforced, models readable.
- **Real check with the native image** (throwaway container, the WeSpeaker benchmark on 3 CPUs alongside): the three
  transcribe windows **still TIMEOUT** at 240 s. Diarization succeeded (RTF 1.60, 5 speakers). Liveness: 1708
  probes, 0 failures, p99 26 ms, max 54 ms. Peak memory 483 MiB, no OOM kill.
- **Root cause of the contradiction:** timings on this host are bimodal, whatever the build.
  - Same-moment A/B: portable 339.7 s vs `GGML_NATIVE` 359.0 s.
  - Landlock off made no difference (still over 300 s).
  - See the CORRECTION in `phase2c-provider-validation/stt-speed-2026-11-24/README.md`. The earlier "5.5–5.8×"
    is not established.
- **Measurement errors corrected:** `timeout` does not exist on macOS, so two "600 s, no output" tests never ran.
- **Next:** an interleaved A/B (`vip-stt-wheel-probe` vs `vip-audio-service`, 3 repetitions each, window 30–60 s) on
  an idle host after the C3 queue. Keep the native build only if it measurably helps; otherwise propose reverting
  it.

## Update 2026-11-24 22:40 IST (session 3, continued): STT speed measured

- The user chose "measure fixes first". Results: `docs/development/phase2c-provider-validation/stt-speed-2026-11-24/`.
- **Root cause:** the pywhispercpp Linux aarch64 wheel lacks `DOTPROD` and `FP16_VA`.
- **Fix candidate:** rebuild from the same sdist (whisper.cpp 1.8.5) for the CPU. It is about 5.5–5.8× faster:
  RTF 2.15–2.70 per window at 1 CPU, inside the 4× deadline. Language decisions are unchanged.
- Sized `audio_ctx` gives no reliable gain; 4 threads were slower.
- **User decision needed:** adopt the native build. That changes the Dockerfile build stage (toolchain, sdist build,
  library path and portable arch flags) and ADR-0036.
- Added `Read(./storage/**)` to the `.claude/settings.json` deny list (user-approved). Hook tests: 123/123 pass.
- The time in the next heading was an estimate; the measured clock that evening read 21:20 at the smoke test.

## Update 2026-11-24, session 3: verified results

Phase 2B / 2C are **still not accepted**. There is one open user decision (STT speed, see the end of this section).

### Completed and verified

| Step | Result | Evidence |
| --- | --- | --- |
| Container suite `pnpm audio:test:container` | **957 passed, 0 failed**, 12 skipped. The skips are pre-existing environment gates: compose-hardening needs `AUDIO_SERVICE_TEST_DOCKER`, plus the long-file dir and 2 kernel/path conditionals | run 2026-11-24 |
| Cause of the first container run's 85 failures / 182 errors | `ENOSPC` on the test's 16 MB `/tmp`. Pytest keeps every `tmp_path` until session end; the suite now needs about 20 MB because of the Phase 2C inference tests (diarize whole-file 3.7 MB, span test 2.3 MB). **Fix:** the test harness tmpfs is now 64 MB (`package.json`, `SETUP.md`); `noexec,nosuid,nodev` are kept and the **service's** tmpfs stays 16 MB | measured with a 512 MB diagnostic tmpfs |
| `test_runner` fd tests | Pass with the script's `-s`. Without `-s`, pytest's capture holds fds 3–10, and `sh -c "cat <&N"` (dash) cannot take two-digit fds. This was an artefact of the diagnostic runs, not a defect | — |
| **Production defect found and fixed:** Landlock cannot confine reads from Docker Desktop host bind mounts (`fakeowner`) | Every real inference task failed in about 1 s (`INTERNAL_ERROR`): the confined child got `PermissionError` on `/models/...` | Measured: rule on `/models` denied on `fakeowner`, allowed on ext4; with no rule, denied on both |
| Fix (no weakening) | Compose serves `/models` from the named volume `audio-models`, filled on every `up` by the one-shot `audio-models-init` (root without capabilities, no network, read-only rootfs), and mounted **read-only**. SHA-256 is still verified at startup. **New startup self-test** `isolation.models_readable`: if the confined child cannot read every pinned model, readiness reports `inference_models_unreadable` | `compose.yaml`, `.env.example`, LLD §3.1, SETUP; tests in `test_api.py`, `test_isolation_unit.py`, `test_inference_sandbox_container.py` |
| Redeployed audio service | `inference_models: transcribe true, diarize true`; Landlock ABI 8, enforced, scoped; `inferenceLandlockEnforced: true`; `inferenceModelsReadable: true`; `/models` is ext4 read-only; healthy | `docker logs vip-audio-service-1` |
| **Responsiveness under real inference** (step 3) | About 15 min of real whisper.cpp and sherpa-onnx inference in a throwaway container with the same image and limits (768 MB, 1 CPU, read-only, own random token, synthetic 90 s clip). **1719 `/health/live` probes, 0 failures**: p50 3 ms, p99 13 ms, max 0.56 s; status polls max 0.57 s. Peak memory 482 MiB, no OOM kill. **The GIL defect is fixed** | `docs/development/phase2c-provider-validation/responsiveness-check-2026-11-24.json` |
| Diarization, real (same check) | Whole-file, 90 s clip: **succeeded**, RTF 1.66, 5 speakers (the reference has 4 in the full 5-min file), 14 turns | same file |
| Integration suites (step 4) | **DB 57/57, API 67/67, orchestrator 60/60**; `pnpm lint` and `pnpm typecheck` pass | run 2026-11-24 |
| Orchestrator regressions fixed | (1) **Code bug:** an unknown provider key gave "AUDIO_SERVICE_TOKEN is required" instead of `UnknownProviderError`, because the audio client was built before the keys were validated. Now `assertKnownProviders` runs first (`registry.ts`, `run.workers.ts`). (2) Two tests set fixed bounds and now also set `RUN_*_PER_AUDIO_PERMILLE: '0'`, because the ADR-0039 duration-scaled share was added; their intent is unchanged | `apps/orchestrator/test/runs.int-spec.ts` |

### Not done or blocked

- **BLOCKER (user decision): real STT is too slow at 1 CPU.** All three 30 s windows hit the 240 s inference deadline
  (`120 s + 4 × 30 s`).
  - Timed in the same container, in-process and **unconfined**: one window took **472 s (RTF 15.7)**, with correct
    output (5 spans, 6 segments, `en` + `hi`). So the sandbox is not the cause.
  - Cause: every VAD span costs a full 30 s whisper encoder pass, plus language detection. The C3 benchmark already
    measured `cpp-small` **single-pass** at 1 CPU as RTF 2.84 short and 4.19 long. The build has NEON, ARM_FMA and
    OpenMP.
  - The earlier "RTF 18.6, heavy CPU contention" note was this cost, not contention.
  - **ADR-0036 cannot be finalised and the real browser end-to-end run cannot pass until this is decided.**
- **Benchmarks (step 5): running** (session-3 queue, log `.local-benchmarks/c3-completion-2026-11-24-session2.log`):
  WeSpeaker accuracy, then WeSpeaker resources, then cpp-medium pass b.
  - `run.py` ignores `docker run` exit codes, so judge each step by its `NEW-FILES` line and the file contents.
  - `diar-results/feasibility-wespeaker.json` (16:48, exit 1) was written while Docker was down. It is invalid
    until regenerated.
- ADR-0036 / ADR-0037 are not written (step 6). They wait for the benchmark results; ADR-0036 also waits for the
  STT decision.
- Real-provider browser end-to-end run (step 7): **not started.** Needs the STT decision, then a user restart of the
  orchestrator with `STT_PROVIDER=whisper-cpp DIARIZATION_PROVIDER=sherpa-onnx`.
- Dev tooling: `node --test .claude/hooks/tests/` has 1 failure. The test expects the deny rule `Read(./storage/**)`
  in `.claude/settings.json`; the file (unchanged since HEAD) has `Read(/storage/**)` and
  `Read(./.local-storage/**)`. Not changed: the user decides.
- `pnpm format:check` warns on `.agents/`, `.codex/` and `AGENTS.md`, which this session did not touch.

## Update 2026-11-24 19:30 IST (resume session 2)

- **§7 step 1 done (option b).** Inference now runs through `SandboxRunner` with an *inference profile*
  (`isolation.inference_runner`). It applies the same controls as FFmpeg children: Landlock read/execute beneath
  `/usr`, `/lib`, `/etc`, plus `realpath(sys.prefix)` (the venv) and the models dir; no TCP; scoped signals and
  sockets; `CPU` / `FSIZE=0` / `NOFILE=64` / `CORE=0` rlimits; a fixed env (`PATH`, `LC_ALL` plus the thread pins,
  never the token); stdin `/dev/null`; process-group kill; capped stdout. The task message is passed as argv.
  - Runner additions: `read_exec_paths`, `extra_env` (`PATH` and `LC_ALL` cannot be overridden) and
    `run(cpu_threads=)`. All defaults are unchanged.
  - `isolation.py` no longer imports `subprocess`, so the architecture guard passes **unchanged**.
  - The app self-tests the inference runner at startup; with `landlock=required`, readiness fails unless it is
    enforced.
  - Tests: `test_isolation_unit.py` (8 tests, run through the real runner); new container-only tests in
    `test_inference_sandbox_container.py`: the profile is enforced, the engines import under Landlock and rlimits,
    models are readable and storage is not.
  - `test_remediation_unit.py`: the `build_ruleset` doubles take the new path argument.
  - Results: host audio suite **734 passed, 0 failed** (235 container-only skipped); `audio:lint` and mypy clean.
    **The container suite has not been run yet.**
- **Runtime found down.** The Docker daemon is not running, and the host was rebooted at about 17:17. Nothing
  listens on `:3000`, `:5173` or `:8001`.
- **C3 queue did NOT complete.** Docker died at 16:48 during cpp-medium, and the log's `exit=0` lines are wrong.
  - cpp-medium wrote only pass a (`.local-benchmarks/stt-results/accuracy-cpp-medium-a.json`, 16:22); pass b is
    missing.
  - `wespeaker-eval` and `wespeaker-resources` never ran.
- **Next:** start Docker and the infra, run `pnpm audio:test:container`, then continue from §7 step 2.

Written 2026-11-24 16:31 IST, when work paused at the user's request (usage limit). Nothing is committed.
**Phase 2B and Phase 2C are NOT yet recorded as accepted**: the closure is in progress.
`docs/development/PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` has **not** been written yet.

User brief (2026-11-24) and everything they approved:
- accept Phase 2B and Phase 2C;
- resolve OD-02b and OD-03b with free, local providers;
- fix both UI defects;
- complete the C3 benchmark;
- resolve the remaining decision items;
- run real-provider end-to-end validation;
- write the final acceptance report.

## 1. Status at a glance

| Item | Status |
| --- | --- |
| UI defect 1 (stale recording header, player, duration and sidebar) | **Done, unit-tested; verified live once**: the header showed "Valid" right after processing, without a reload, in the real browser run |
| UI defect 2 (timeline "later phase" copy) | **Done, unit-tested**; not yet seen in the browser |
| OD-02b STT provider | **Selected and implemented**; real end-to-end run **failed** (blocking defect, §4) |
| OD-03b diarization provider | **Selected and implemented**; not yet exercised end to end (the run failed in transcription) |
| OD-29 VAD (Silero) | **Selected and implemented** (speech spans inside transcription windows); ADR-0038 written |
| D-2B-20 / OD-10 / D-2B-18 / D-2B-19 | ADR-0039 written; audio service raised to 768 MB |
| OD-18, OD-39, OD-04 split, OD-23a, D-2B and D-2C acceptance | ADR-0040 written |
| ADR-0036 (STT) and ADR-0037 (diarization) | **NOT written yet**: waiting for the benchmark results. The HLD register already points to them |
| C3 benchmark (whisper.cpp medium accuracy, WeSpeaker evaluation, report regeneration) | **Running in the background**: cpp-medium accuracy started 15:20 |
| 60 s vs 3 min discrepancy | **Resolved from the code**: `rtf-mixed.wav` is 161.85 s; the RTF pass measures its first 60 s (`RTF_AUDIO_S = 60.0`). The README text still needs this correction |
| Real-provider browser end-to-end run | **Started 16:20, failed**: run `ab0dd983-…`, `AUDIO_UNAVAILABLE` on transcription. The browser script may still be waiting on its 1 h timeout |
| Final acceptance report, PROJECT_STATUS update, memory update | **Not done** |

## 2. Provider selections (implemented, partly validated)

The selections are evidence-based. No provider "recommendation" had been documented before: the C3 README said
"selects nothing". The hardware budget is an Apple M1 with 8 GB.

- **OD-02b STT: Whisper small**, whisper.cpp ggml `q5_1` (MIT; `ggerganov/whisper.cpp` @ `5359861c…`, SHA-256
  `ae85e4a9…11bb`), via pywhispercpp 1.5.1 (MIT), running in the audio service's `transcribe` task.
  - Each 30 s window is split by **Silero VAD v6.2.3** (MIT, SHA `1a153a22…88e3`, run by sherpa-onnx).
  - Each speech span is decoded on its own, with its own `en`/`hi` language. Urdu probability counts towards Hindi.
  - Reason for spans (measured): Whisper decodes one language per pass. On a mixed 30 s window, forced `hi` gave
    one wrong segment and forced `en` *translated* the Hindi. With spans, every span was correct (en 0.97 / 0.96 /
    0.95, hi 0.92 / 0.88).
  - Medium models do not fit: whisper.cpp medium and faster-whisper medium were OOM-killed at 512 MB.
- **OD-03b diarization: sherpa-onnx 2.0.2** (Apache-2.0) + pyannote segmentation-3.0 ONNX (MIT, ungated GitHub export,
  SHA `220ad67c…1079`) + 3D-Speaker CAM++ en VoxCeleb (Apache-2.0, SHA `98daf9bc…8bb5`).
  - Clustering threshold 0.6 (C3 dev-tuned), min-on 300 ms, min-off 500 ms.
  - Bounded memory (ADR-0016): whole file up to 10 min; otherwise 10 min windows with 30 s overlap, one CAM++
    embedding per window speaker, greedy one-to-one matching at cosine ≥ 0.5, turns clipped to each window's owned
    span.
  - The match threshold 0.5 is the midpoint of a flat region: dev DER was identical for 0.3–0.7.
  - WeSpeaker is the comparison candidate; its evaluation is still running.

Evidence collected so far (synthetic TTS corpus only):

| What | Result | Where |
| --- | --- | --- |
| Windowed diarization, dev tuning | DER flat across thresholds | `docs/development/phase2c-provider-validation/windowed-tune.json` |
| Windowed diarization, test split | windowed vs whole: 0.174 vs 0.225, 0.104 vs 0.264, 0.070 vs 0.059 | `windowed-test.json` |
| Windowed diarization, 60-min file (production settings, 7 windows) | **DER 0.0768** (C3 whole-file baseline 0.2518); 11 speakers found vs 4 in the reference (over-clustering) | `windowed-long.json` |
| Container measurements (production code, 1 CPU) | see below | scratchpad `inference-check/` (not durable) |

Container measurements:

| Case | Anonymous peak | RTF | Notes |
| --- | --- | --- | --- |
| Single-pass STT window, 512 MB | **488.8 MiB** | — | Too close to the limit, hence 768 MB |
| VAD-span STT window, 768 MB | **394.7 MiB** | 18.6 | Heavy CPU contention from the benchmark |
| 5-min diarization, whole file | 282.8 MiB | 1.2 | 8 speakers found vs 4 in the reference (over-clustering) |

**An uncontended RTF re-measurement is still needed.** On the macOS host, natively, span decoding measured RTF 0.33
on one thread.

## 3. Code state (uncommitted)

- **Contracts:** `packages/contracts/src/audio-service.ts` adds task types `transcribe` and `diarize`, plus
  `AudioTranscribeConfig/Result`, `AudioVadSettings`, `AudioDiarizeConfig/Result` and `AudioEngineInfo`. There are
  new fixtures `transcribe-*.json` and `diarize-*.json`. `transcription.ts` adds `AudioSourceRef` and an optional
  `source` field on the STT and diarization requests. The Python mirror is in
  `services/audio/src/audio_service/contracts.py`.
- **Audio service, new modules:** `domain/inference_models.py` (pinned files, `ModelStore`), `canonical_audio.py`,
  `transcribe.py`, `diarize.py`, `isolation.py`, `inference_child.py`.
- **Audio service, changed modules:** `storage.py` (`open_published_file`, `PublishedFile`), `tasks.py` (inference
  budget), `config.py` (`models_dir`, `inference_threads`, `inference_deadline_per_audio_ms_permille`), `api/app.py`
  (registers the handlers only when the models verify).
- **Audio service, other files:** `scripts/fetch_models.py`; `benchmarks/diarization/windowed_eval.py`;
  `pyproject.toml` and `uv.lock` (pywhispercpp and sherpa-onnx promoted to runtime dependencies; no version change).
- **Orchestrator:** `providers/audio-task.ts`, `providers/stt/whisper-cpp.ts`, `providers/diarization/sherpa-onnx.ts`
  and `registry.ts` (keys `fake | whisper-cpp | sherpa-onnx`); `runs/run.step.ts` (passes `source`; duration-scaled
  `providerTimeoutMs` and `runDeadlineMs`); `runs/run.workers.ts`; `config.ts` (`DIARIZATION_*`, `STT_VAD_*`,
  `PROVIDER_POLL_INTERVAL_MS`, `RUN_*_PER_AUDIO_PERMILLE`); test `providers/self-hosted.spec.ts`.
- **Web (by frontend-engineer):** `pages/recording-detail.tsx`, `transcription/transcript-section.tsx`
  (`onRunStatusChange`), `timeline/timeline-placeholder.tsx`, and new tests `recording-detail.refetch.test.tsx` and
  `timeline-placeholder.test.tsx`.
- **Infra and config:** `infra/docker/compose.yaml` (models mount `/models:ro`, `AUDIO_SERVICE_MODELS_DIR`,
  `OMP_NUM_THREADS=1`, memory 768m); `.env.example`; `.gitignore` (`.local-models/`); root `package.json`
  (`audio:models`).
- **Docs:**
  - ADR-0038, ADR-0039 and ADR-0040 are new.
  - Status lines updated in ADR-0002, 0012, 0016 and 0023.
  - HLD §10 rows updated: OD-02a/b, OD-03a/b, OD-04a/b, OD-10, OD-18, OD-23a, OD-29, OD-39.
  - LLD, `.claude/rules/python-audio.md`, the `add-provider-adapter` skill and `CLAUDE.md` (status and ADR-0002
    lines) updated.
  - By documentation-agent: SRS, AGENT_ARCHITECTURE, DEPLOYMENT_ARCHITECTURE, TESTING_STRATEGY, SETUP,
    API_SPECIFICATION and `frontend-design/audio-visualisation.md`.
- **Models:** installed in `.local-models/` (gitignored) via `pnpm audio:models`: whisper, vad, two diarization files.

## 4. The blocking defect (being fixed when paused)

The real run failed because **pywhispercpp holds the Python GIL during inference**, so the audio service's HTTP event
loop stopped responding. `/health/live` timed out at 10 s. The orchestrator's 3 s status polls failed, which became
`AUDIO_UNAVAILABLE` and exhausted the retries.

The fix is **in progress, not deployed**:
- `domain/isolation.py` and `domain/inference_child.py` run inference in a child process.
- The child gets the inherited, already-checked canonical-WAV descriptor; it does not get the service token.
- Progress and the result come back as JSON lines on stdout.
- Cancellation and the deadline kill the child's process group; a signal kill is reported as `RESOURCE_EXHAUSTED`.
- Both handlers default to `isolate=True`.
- New tests: `tests/test_isolation_unit.py` (4 tests, pass) with `tests/inference_child_stub.py`.

**Open item:** `tests/test_architecture_extra.py::test_only_the_runner_and_capability_probe_spawn_processes` fails,
because `isolation.py` is a new subprocess user. Decide whether to:
- (a) allowlist `isolation.py`, recording the child's weaker sandbox (no Landlock) in ADR-0036 as a residual risk; or
- (b) run the child through `SandboxRunner` (Landlock, rlimits). That needs the venv and `/models` on its read paths
  and an `RLIMIT_FSIZE`/`NOFILE` check.

I was checking `runner.py` for (b) when work stopped.

## 5. Test status (last runs)

| Suite | Result |
| --- | --- |
| contracts | 170 pass |
| db unit | 5 pass |
| orchestrator unit | 116 pass |
| api unit | 211 pass |
| web | 262 pass |
| typecheck, lint | pass |
| audio (after the isolation change) | 729 pass, **1 fail** (the guard above), 233 container-only skipped |

Integration tests (DB 57, orchestrator 60, API 67) passed earlier today, **before** the provider work. They must be
re-run.

## 6. Runtime state (left running; nothing stopped)

- **Containers:**
  - `vip-postgres-1` (`127.0.0.1:5432`) and `vip-redis-1` (`127.0.0.1:6379`), healthy.
  - `vip-audio-service-1` (`127.0.0.1:8001`, 768 MB): **runs the pre-isolation image**, so any real inference task
    blocks it.
  - A benchmark container, randomly named.
- **Dev processes (yours):** API `:3000`; web (Vite) `:5173`; orchestrator restarted by you with
  `STT_PROVIDER=whisper-cpp DIARIZATION_PROVIDER=sherpa-onnx`. **New transcription runs started from the UI will
  fail** until the isolation fix is deployed. To use the app meanwhile, restart the orchestrator without those two
  variables (fakes).
- **Database `vip`:**
  - Migration 0004 is applied. Backup: `.local-backups/pre-0004-20261124T150407.dump`.
  - Added since then: recording `aa3e95e9-…` (completed fake run `89448e90-…`) and recording `3298fb20-…` (failed
    real run `ab0dd983-…`), both synthetic.
- **Background jobs started by me** (they finish on their own; outputs are durable):
  - C3 queue, script in the session scratchpad: cpp-medium accuracy, then WeSpeaker accuracy, then WeSpeaker
    resources. Log: `.local-benchmarks/c3-completion-2026-11-24.log` (real exit codes, `START`/`END` lines).
  - `windowed_eval.py long --threshold 0.5` **finished** and wrote
    `docs/development/phase2c-provider-validation/windowed-long.json`.
  - The browser script `run-real.mjs` (scratchpad) ends at its timeout.
- **Agents:** all finished, none running. frontend-engineer (UI fixes) and documentation-agent (two passes:
  benchmark README, living docs) both completed. Earlier: security-reviewer and test-engineer.

## 7. Remaining work, in order

1. **Isolation:** decide (a) or (b) in §4; make `pnpm audio:test` green; `pnpm audio:lint`.
2. **Redeploy the audio service:**
   `docker compose -f infra/docker/compose.yaml --env-file .env --profile audio up -d --build audio-service`.
   Then check `/health/live` stays responsive while a task runs.
3. **Integration tests:** `pnpm test:integration`. Expect DB 57, orchestrator 60, API 67; fix any provider-related
   regressions.
4. **Real end-to-end run:** the orchestrator must still run with the two provider variables. Then
   `node <scratchpad>/e2e/run-real.mjs`. If the scratchpad is gone, recreate the 90 s clip from
   `.local-benchmarks/diar-corpus/conversations/test-4spk-b-5min.wav` (first 90 s, which contains English speakers
   and Hindi at 66–81 s). Verify through the API and DB:
   - providers `whisper-cpp` / `sherpa-onnx` with `fake: false`;
   - Devanagari and English segments;
   - several speakers;
   - raw outputs carrying the `audio-service-transcribe-v1` envelope;
   - workspace 404s;
   - the sidebar updating without a reload, and the timeline copy.
5. **Uncontended container RTF**, after the benchmark finishes: re-run the transcribe and diarize checks at
   768 MB / 1 CPU, and the 60-min windowed diarization memory (bounded-memory evidence).
6. **Benchmark:**
   - When the queue ends, read the `END … exit=` lines.
   - Run `uv run --directory services/audio --no-dev python benchmarks/stt/run.py report`.
   - Update `phase2c-stt-benchmark/README.md` with: the cpp-medium accuracy, the WeSpeaker DER, the
     60 s / 161.85 s explanation, and that `check-runtime` now treats pywhispercpp and sherpa-onnx as runtime.
7. **Write ADR-0036 and ADR-0037**, with benchmark, licence, resource and limitation evidence; copy durable evidence
   into `docs/development/phase2c-provider-validation/README.md`.
8. **Graphify:** `graphify update .`, then check the API → orchestrator → audio-task → handler paths and record the
   parser limits.
9. **Write** `docs/development/PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`. Then update `PROJECT_STATUS.md` (Phase 2B and
   2C COMPLETE — ACCEPTED only if steps 1–7 pass), the `PHASE2B_COMPLETION.md` / `PHASE2C_*` records, and memory.
