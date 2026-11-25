# STT speed measurement, 2026-11-24 (user-approved: "measure fixes first")

> **ADR-0041 validation (2026-11-25, 22:17–22:24): the real-service check at 2 CPUs PASSES.**
>
> - **Setup:** same image `sha256:97699c52…`, 768 MB, 2 CPUs, 2 threads, Landlock enforced (ABI 8, scoped), models
>   readable, readiness 200.
>
>   | Task | Result |
>   | --- | --- |
>   | Transcribe 0–30 s | succeeded, 113.7 s, `en` |
>   | Transcribe 30–60 s | succeeded, 115.9 s, `en` |
>   | Transcribe 60–90 s | succeeded, 148.1 s, `en`, `hi` (2 Devanagari segments) |
>   | Diarize 90 s | succeeded, 49.3 s (RTF 0.55, was 1.66 at 1 CPU), 5 speakers, 14 turns |
>
> - **Health:** 846 liveness probes, 0 failures, p99 19 ms. Peak memory 574 MiB of 768 MiB, no OOM kill.
> - **Tests:**
>   - Container suite: 960 passed, 12 skipped.
>   - Docker-driven Compose hardening suite: 9 of 9 passed. Two stale assertions there were updated to the documented
>     limits: 768 MB / 2 CPUs, and the read-only `/models` mount.
> - **File:** `real-check-2cpu-2026-11-25.json` (numbers only).

> **E8 RESULT (2026-11-25, 20:33–20:48): the current code path scales almost linearly with CPUs.**
>
> - **Setup:** standard-wheel image `sha256:97699c52…`, Low Power Mode off, idle host, 768 MB, threads equal to
>   CPUs, variant V0 (the deployed code). Deadline: 120 s + 4 × 30 s = 240 s.
>
>   | Window | 1 CPU | 2 CPUs | 4 CPUs |
>   | --- | --- | --- | --- |
>   | 60–90 s (5 spans, en/hi) | **278.4 s (fails 240 s)** | 143.0 s | 72.6 s |
>   | 30–60 s (4 spans) | 218.0 s (9 % margin) | 112.5 s | 56.8 s |
>
> - **Languages:** identical at every CPU count (`en hi hi en en`, `en ×4`).
> - **Cost model:** about 27 s per encoder pass at 1 CPU, with 2 passes per span.
>   - At 1 CPU, any window with 5 or more spans exceeds the deadline.
>   - At 2 CPUs, about 8 spans fit.
>   - At 4 CPUs, about 16 spans fit.
> - Raising the CPU limit is a decision for the user (ADR), not a code change.
> - **File:** `e8-cpu-scaling-2026-11-25.log` (numbers only).

> **E7 RESULT (2026-11-25): a decode `audio_ctx` sized to the span FAILS the accuracy gate. The change was
> reverted (never deployed or committed). B-1 remains OPEN.**
>
> - **What was tested:** the current decode at full encoder context against a decode with
>   `audio_ctx = min(1500, ceil(span_ms / 20) + 64)`.
>   - Both used the same spans and the same language decisions: every span detected first, at full context.
>   - Corpus: the C3 test split, 240 synthetic clips, 1,082 s in total.
>   - Setup: 4 CPUs, 4 threads, standard-wheel image.
>
>   | WER (CER) | Full context (current) | Sized context |
>   | --- | --- | --- |
>   | English, all SNR | 0.105 (0.073) | 0.187 (0.147) |
>   | Hindi, all SNR | 0.487 (0.236) | 0.895 (0.722) |
>   | Hinglish, all SNR | 0.841 (0.830) | 1.025 (0.920) |
>
> - **The regression appears in every language and at every noise level,** including on clean audio.
> - **Language ID:** unaffected by construction, since both variants share it. It was en 77/80 (3 clips without
>   speech), hi 80/80, Hinglish hi 78 / en 2.
> - **Speed:** the sized decodes were not materially faster on this corpus, 1,734 s against 1,928 s. The single-span
>   3.7 s vs 28.2 s from E6 does not generalise. WER above 1.0 indicates inserted or repeated text.
> - **Also measured: whisper.cpp 1.8.5 ordering quirk.** `whisper_full_with_state` runs language detection before it
>   applies `params.audio_ctx`, so detection reuses the context left by the previous call. Earlier V1/V2 detection
>   timings were affected by this.
> - **Files:** `e7-audio-ctx-accuracy-2026-11-25.log` (numbers only). The per-clip rows stay in the gitignored
>   `.local-benchmarks/b1-audio-ctx/`.

> **RESULT (2026-11-25): the source build gives no meaningful speed-up and has been reverted to the standard wheel
> (user decision). B-1 remains OPEN.** This supersedes the "5.5–5.8×" claim and the CORRECTION below.
>
> **Measured: idle-host interleaved A/B**, 2026-11-25 09:16–09:51. Window 30–60 s, variant V0, 1 CPU, 768 MB,
> `OMP_NUM_THREADS=1`. Other containers were at 1.4 % CPU or less before each run.
>
> | Rep | Standard wheel | Source build (`armv8.2-a+dotprod+fp16`) |
> | --- | --- | --- |
> | 1 | 350.8 s, RTF 11.69 | 348.6 s, RTF 11.62 |
> | 2 | 350.8 s, RTF 11.69 | 339.1 s, RTF 11.30 |
> | 3 | 347.4 s, RTF 11.58 | 353.6 s, RTF 11.79 |
> | Mean | 349.7 s | 347.1 s |
>
> Languages were identical in every run (`en` ×4).
>
> **Measured: real service check, idle host** (source-build image, Landlock enforced): all three transcribe windows
> hit `TIMEOUT` at about 240.6 s. Diarize succeeded (RTF 1.67, 5 speakers). Liveness: 1720 probes, 0 failures, p99
> 18 ms. Peak memory 546 MiB, no OOM kill.
>
> **Interpretation:**
>
> - The DOTPROD/FP16 flags do not change throughput measurably for this model and path.
> - Idle-host speed is about RTF 11.6 at 1 CPU, so host contention does not explain the timeouts.
> - The 65–81 s results in the table below are unexplained outliers and must not be used.
>
> **Proposed next experiments** (not started; need approval): idle-host 2/4-thread runs; language detection once per
> window; a shorter window or a smaller model; a longer deadline. See the checkpoint for details.
>
> Files: `ab-idle-2026-11-25.log` (A/B log with load-before lines) and `real-check-idle-2026-11-25.json` (real
> check). Both contain numbers only.

> **CORRECTION (2026-11-24, about 23:10 IST): the speed-up claimed below is NOT established.**
>
> - A same-moment A/B on the 30–60 s window, identical `docker run` flags, while the WeSpeaker benchmark ran on 3
>   CPUs: `GGML_NATIVE` build 359.0 s (RTF 11.97); the repository image (portable `armv8.2-a+dotprod+fp16`
>   build) 339.7 s (RTF 11.32).
> - The same `GGML_NATIVE` image had done this window in 65 s an hour earlier.
> - Per-span cost on this Docker Desktop / M1 host is **bimodal**: about 8 s or about 45 s per span, whatever the
>   build. The "5.5–5.8×" below compared runs taken at different times, so host contention, not the build, may
>   explain it.
> - Plausible cause (not verified): macOS placing busy VM vCPU threads on efficiency cores.
> - **Next:** an interleaved, repeated A/B (wheel image `vip-stt-wheel-probe` vs the repository image) on an idle
>   host, after the C3 queue ends. Until then, the native build's benefit is unproven and STT RTF on this host is
>   known only as 2.2–12 per window, depending on load.

This is a measurement only; nothing is changed in the repository. The input is the synthetic 90 s clip (the first 90 s
of `test-4spk-b-5min`, TTS, ADR-0004), cut into three 30 s windows. Each window is split into Silero VAD spans with
the service's code and settings. The outputs contain numbers only: times, languages and disagreement counts.

## Why it was measured

In the deployed audio service (768 MB, 1 CPU), all three real `transcribe` windows hit the 240 s inference deadline.
Timed unconfined and in-process in the same container, one window took 472 s (RTF 15.7), so the sandbox is not the
cause (`../responsiveness-check-2026-11-24.json`).

## Finding: the pywhispercpp Linux aarch64 wheel is built without the CPU's features

| Build | `whisper_print_system_info` CPU flags |
| --- | --- |
| Linux wheel, in the image | `NEON ARM_FMA OPENMP REPACK` |
| Rebuilt from the same sdist, `GGML_NATIVE=ON` | `NEON ARM_FMA FP16_VA DOTPROD OPENMP REPACK` |
| macOS wheel (host) | `NEON ARM_FMA FP16_VA DOTPROD ACCELERATE REPACK` + Metal GPU |

- The VM's CPU offers `asimddp` (DOTPROD) and `asimdhp` (FP16).
- Both Linux builds use whisper.cpp 1.8.5 and ggml 0.13.1, so the libraries are the same version.
- The "native RTF 0.33" from the earlier session was measured on the macOS host, which has Accelerate and Metal. It
  is not comparable to the container.

## Results (1 CPU unless stated; the C3 WeSpeaker accuracy benchmark was using 3 other CPUs at the same time)

| Window | Wheel, V0 (current code) | Native, V0 | Native, V1 | Native, V2 | Native, V0, 4 CPU / 4 threads |
| --- | --- | --- | --- | --- | --- |
| 0–30 s (4 spans) | V2 only: 357 s, RTF 11.9 | 339 s (first-run outlier) | 106 s | 65 s (degenerate output, disagreement 1.0) | 104 s |
| 30–60 s (4 spans) | — | **65 s, RTF 2.15** | 73 s | 65 s | 93 s |
| 60–90 s (5 spans, en/hi) | 472 s, RTF 15.7 (measured unconfined, no other load) | **81 s, RTF 2.70** | 81 s | 103 s | 120 s |

- **Variants:**
  - V0: the current code, i.e. full language detection, then a full decode per span.
  - V1: as V0, but the decode uses `audio_ctx` sized to the span.
  - V2: `audio_ctx` sized for both detection (`whisper_full` with `detect_language`) and decode.
- **Native build:** about **5.5–5.8× faster** than the wheel. The current per-span design fits the 4× inference
  deadline at 1 CPU (65–100 s used against 240 s allowed). Language decisions are identical to V0, with `en`, `hi`,
  `hi`, `en`, `en` in the mixed window.
- **`audio_ctx`:** no reliable gain. Detection costs about 8 s per span either way. V2 degenerated in window 0.
- **4 threads:** slower than 1 thread here, under contention from the benchmark.
- **Accuracy proxy:** only agreement with V0 output. A corpus WER run of the native build is still needed before
  adoption.

Files: `native-1cpu.json`, `native-4cpu.json`, `wheel-1cpu-V2-window0.json`, `experiment.py`,
`native-probe.Dockerfile` (scratch image, not used by the repository).
