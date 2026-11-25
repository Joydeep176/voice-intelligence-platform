# ADR-0041: Audio service 2 CPUs and 2 inference threads (B-1)

- Status: **Accepted** (user decision 2026-11-25; confirmed as final by the user on 2026-11-26 with the Phase 2B/2C acceptance)
- Date: 2026-11-25
- Amends: ADR-0039 decision 2 (CPU and thread values only); OD-10 row in HLD §10
- Addresses: Phase 2B/2C closure blocker B-1 (transcription windows exceed the inference deadline)
- Affects: `infra/docker/compose.yaml` (`audio-service`), ADR-0039, HLD §10 OD-10, DEPLOYMENT_ARCHITECTURE, SRS NFR-2

## Context

In the deployed audio service (768 MB, 1.0 CPU, 1 thread) every real `transcribe` window timed out at the 240 s
inference deadline (120 s + 4 × 30 s, ADR-0039). The cause is compute, not the sandbox or the host:

- whisper.cpp small q5_1 spends about 99 % of its time in the encoder. One encoder pass takes about 27 s at 1 CPU on
  the Apple M1 Docker VM (Low Power Mode off). Each speech span needs two passes: one for language detection, one for
  decoding. Per-span language detection is what keeps Hindi-English code-switching accurate (ADR-0036, ADR-0038).
- At 1 CPU, any window with 5 or more spans exceeds 240 s.

E8, the current code at 1, 2 and 4 CPUs (threads equal to CPUs, 768 MB, idle host):

| Window | 1 CPU | 2 CPUs | 4 CPUs |
| --- | --- | --- | --- |
| 60–90 s (5 spans, en/hi) | 278.4 s (fails) | 143.0 s | 72.6 s |
| 30–60 s (4 spans) | 218.0 s | 112.5 s | 56.8 s |

Languages were identical at every CPU count. Evidence:
`docs/development/phase2c-provider-validation/stt-speed-2026-11-24/` (E1–E8, README).

## Options considered

1. **Decode with an encoder context sized to the span** (code only, no limit change). Rejected after E7, on 240
   synthetic C3 clips:
   - WER rose for English from 0.105 to 0.187, for Hindi from 0.487 to 0.895, and for Hinglish from 0.841 to 1.025.
   - It was not materially faster.
2. **A source build with DOTPROD/FP16:** no measurable gain (idle A/B). Reverted.
3. **2 CPUs, 2 threads:** about 8 spans fit per window. Nothing else changes.
4. **4 CPUs:** about 16 spans per window. Takes half the VM's 8 CPUs, competing with Postgres, Redis and the apps.
5. **A longer deadline at 1 CPU:** it would have to scale with the span count, and transcription would run at about
   9× real time. Changes acceptance criteria.
6. **A smaller model (base):** changes the selected model (ADR-0036) and would weaken Hindi and Hinglish accuracy.
7. **Detecting language once per window:** gives up per-span code-switching. Not acceptable.

## Decision

**Option 3 (user decision, 2026-11-25).**

- The audio-service container gets **2.0 CPUs**, up from 1.0.
- `AUDIO_SERVICE_INFERENCE_THREADS=2` and `OMP_NUM_THREADS=2` are set.
- Memory stays at 768 MB, and pids at 64.
- Unchanged: one task at a time, the model (whisper.cpp small q5_1), the 240 s formula, per-span language detection,
  and the sandbox (Landlock, rlimits; the RLIMIT_CPU budget already scales with the thread count).

The thread setting is shared, so diarization (sherpa-onnx) also runs with 2 threads.

## Consequences

- **Known limitation, temporarily accepted by the user (2026-11-26): dense, fragmented speech against the 240 s
  deadline.** This is a limitation, not a passing performance test. These settings are unchanged by this ADR:
  CPU 2.0, memory 768 MB, 30 s windows with 1 s overlap, and the deadline of 120 s + 4 × window audio (240 s for a full
  window).
  - **Cost:** whisper.cpp needs about 2 encoder passes per speech span, roughly 30 s per span at 2 CPUs including
    overhead. The measured windows took 113.7 s / 115.9 s for 4 spans, 148.1 s for 5, and about 196 s for 6
    (Hinglish).
  - **Capacity:** about 7 spans per window. More than about 8 exceeds the deadline.
  - **No input cap:** nothing limits spans per window. The VAD settings (speech ≥ 250 ms, silence ≥ 300 ms, 200 ms
    padding) merge pauses shorter than about 0.4–0.7 s. A 13-utterance clip with 0.45 s pauses became 2 spans and
    finished in 60 s.
  - **Realistic load (E10):** across 252 windows of the synthetic conversations, the maximum was 7 spans (one window);
    most had 4–5, and none had more than 8.
  - **Constructed worst case:** 16 utterances of 1 s with 0.8 s pauses gave **14 spans**, run on 2026-11-25 through the
    browser. Each of the 3 automatic attempts ran about 245 s and ended `TIMEOUT`. The run failed with
    `AUDIO_TIMEOUT` after 9.6 min. The UI showed "A transcription window took longer than its processing deadline"
    and offered Retry. Preprocessing stayed completed.
  - A retry of the same window fails again for the same reason.
  - **Evidence:**
    - `docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25/fail-fragmented.json`;
    - `fail-dense.json`;
    - `stt-speed-2026-11-24/e10-spans-per-window-2026-11-25.json`.
  - **Options, none applied:** more CPU, a span-scaled deadline, shorter windows, or merging spans above a cap. Each
    changes a limit or behaviour the user has reserved.
- **Validation (completed 2026-11-25, all passed):**
  - Container suite 960 passed; Compose hardening 9/9 (exactly 768 MB / 2 CPUs).
  - Real-service check: windows took 113.7 / 115.9 / 148.1 s; languages unchanged; `memory.peak` 574 MiB; 0 of 846
    liveness probes failed.
  - Diarization: 49.3 s for 90 s (RTF 0.55). The 60 min windowed run peaked at 524 MiB anonymous, with no OOM.
  - Browser end to end with the real providers passed.
- **Status:** confirmed **Accepted** by the user on 2026-11-26.
- The VM keeps 6 CPUs for the other services. Production sizing remains part of OD-48.
- Docs: ADR-0039 decision 2 is amended; HLD OD-10, DEPLOYMENT_ARCHITECTURE and SRS NFR-2 are updated.
- Host note: macOS Low Power Mode slowed inference about 1.7×, and must be off for measurements.
