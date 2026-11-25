# Phase 2B WS9a: audio service resource benchmarks (M1 8 GB)

Measured 2026-11-21 on the development machine by `pnpm bench:phase2b:resources`
(`services/audio/benchmarks/resources/run.mjs`, sampler `sampler.py`, tables via `report.mjs`).
Raw data: `results.json` (same folder). Synthetic signals only (ADR-0004): FFmpeg `lavfi` pink/white noise with 4 Hz
amplitude modulation, 3 s silence in every 10 s, 5 s of hard clipping in every 60 s (4 h case), digital silence, 8-channel noise.
No real recordings and no datasets.

## Environment

| Item | Value |
| --- | --- |
| Machine | Apple M1, 8 GB, macOS 26.3.1 (25D2128), arm64 |
| Docker | Docker Desktop 4.99.0, engine 29.9.3, Linux VM with 4.1 GB memory and 8 CPUs (setting unchanged), cgroup v2 |
| Audio container | `infra/docker/compose.yaml` service `audio-service` (unchanged): 512 MB, 1.0 CPU, pids 64, read-only rootfs, cap_drop ALL, no-new-privileges, `/tmp` tmpfs 16 MB |
| FFmpeg / ffprobe | 7.1.5-0+deb13u1 (in the image) |
| Python (service) | 3.12.16 |
| Machine state at start | host memory free 52 %; swap used 3,795 MB of 5,120 MB (the host was already under swap pressure); Docker VM process RSS 1,317 MB |
| Machine state at end | host memory free 38 %; Docker VM RSS 1,080 MB |

Nothing of the user's was stopped. The throwaway storage root was outside the repository; the audio service was driven directly
over its internal API (`POST /v1/tasks`, type `preprocess`, config from `buildPreprocessConfig`), not through the API/orchestrator.

## Method

- A fresh audio container per case (series case: one container for all five jobs), so `memory.peak` and CPU counters are per case.
- A separate sampler container shares the audio container's PID namespace and the host cgroup namespace, with `/sys/fs/cgroup`
  mounted read-only, so sampling adds no process and no memory to the measured cgroup. Sample rate 9.8 to 10.3 Hz in every case
  (largest gap 0.17 s). Per sample: `memory.current`, `memory.peak`, `memory.stat` `anon`/`file`, `cpu.stat`, `pids.current`,
  VmRSS/VmHWM of `ffmpeg`/`ffprobe` processes, size of the task temp directory (`.tmp-<taskId>/`, on the bind-mounted disk).
- RTF = wall time of the task (submit to terminal status, 500 ms status polling) / audio duration.
- "Anon peak" is the maximum sampled `anon` value. "cgroup memory.peak" is the kernel counter, cumulative from container start
  (includes the idle baseline of about 40 MB anon). "FFmpeg child peak RSS" is the largest VmHWM seen among FFmpeg/ffprobe processes
  (the kernel high-water mark of those processes; a very short-lived process between two samples could be missed).
  CPU seconds are the `usage_usec` delta between the first and last sample of the job window.

## Results

| Case | Original MB | Status | Wall s | RTF | CPU s | Anon peak MB | cgroup memory.peak MB | Page cache (file) peak MB | FFmpeg child peak RSS MB | Temp peak MB | Output MB | CPU throttled s |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| mono16k-10s | 0.3 | succeeded | 1.0 | 0.1028 | 0.5 | 54.0 | 59.3 | 0.6 | 51.1 | 0.3 | 0.3 | 0.0 |
| stereo44k-5min-mp3 | 4.6 | succeeded | 6.6 | 0.0220 | 6.3 | 80.4 | 89.8 | 13.7 | 55.5 | 9.2 | 9.2 | 2.8 |
| stereo48k-30min-wav | 329.6 | succeeded | 29.3 | 0.0163 | 28.1 | 88.1 | 512.0 | 448.6 | 55.8 | 55.2 | 55.2 | 10.6 |
| stereo44k-60min-m4a | 30.1 | succeeded | 74.3 | 0.0206 | 73.8 | 99.0 | 239.4 | 143.0 | 65.6 | 110.3 | 110.3 | 48.5 |
| stereo48k-4h-flac | 1165.3 | succeeded | 288.0 | 0.0200 | 287.1 | 100.3 | 512.0 | 454.2 | 57.3 | 441.2 | 441.2 | 190.6 |
| silence-10min | 109.9 | succeeded | 9.6 | 0.0160 | 9.3 | 83.4 | 214.5 | 130.7 | 55.7 | 18.3 | 18.4 | 2.9 |
| whitenoise-10min | 109.9 | succeeded | 10.6 | 0.0177 | 10.3 | 81.4 | 211.9 | 128.2 | 58.0 | 18.4 | 18.4 | 3.9 |
| clipped-10min | 109.9 | succeeded | 15.7 | 0.0262 | 15.2 | 94.0 | 214.7 | 128.2 | 55.8 | 18.4 | 18.4 | 4.9 |
| 8ch-192k-30s | 87.9 | succeeded | 7.2 | 0.2390 | 7.1 | 169.7 | 262.5 | 88.8 | 99.8 | 0.9 | 0.9 | 1.7 |
| series-5x30min #1 | 329.6 | succeeded | 29.9 | 0.0166 | 29.2 | 94.3 | 473.4 | 384.5 | 55.8 | 55.2 | 55.2 | 11.5 |
| series-5x30min #2 | 329.6 | succeeded | 28.3 | 0.0157 | 27.9 | 96.2 | 473.4 | 384.5 | 55.9 | 55.2 | 55.2 | 10.0 |
| series-5x30min #3 | 329.6 | succeeded | 27.7 | 0.0154 | 27.3 | 96.3 | 477.7 | 384.5 | 55.9 | 55.2 | 55.2 | 9.0 |
| series-5x30min #4 | 329.6 | succeeded | 27.2 | 0.0151 | 26.7 | 95.8 | 477.7 | 384.5 | 55.8 | 55.2 | 55.2 | 8.8 |
| series-5x30min #5 | 329.6 | succeeded | 28.2 | 0.0157 | 27.7 | 93.3 | 477.7 | 384.5 | 55.8 | 55.2 | 55.2 | 9.8 |


Output equals temp peak in every case because the canonical WAV (16 kHz mono s16: 0.96 MB per 30 s) and the level series are
written to the temp directory and renamed into place at the end. For the 4 h file this is 441 MB of temp disk (canonical WAV
460,800,044 bytes, level series 1.8 MB), on disk and never tmpfs; the 16 MB `/tmp` tmpfs was not used for task data.

### Five consecutive 30 min jobs (one container)

| Job | Anon peak MB | Idle anon after job MB |
| ---: | ---: | ---: |
| 1 | 94.3 | 51.7 |
| 2 | 96.2 | 49.7 |
| 3 | 96.3 | 51.9 |
| 4 | 95.8 | 50.8 |
| 5 | 93.3 | 49.0 |

Peak growth first to last: -1.1 %; idle growth first to last: -5.2 %.


Target was at most 10 % anon growth across jobs: met (no growth; the values are flat within sampling noise).

## The 4 h row (OD-10 interim maximum, 14,400,000 ms)

- Input: 4 h stereo 48 kHz FLAC, 1,165 MB (ffprobe: 14400.000000 s). Accepted at the limit, result `succeeded`, canonical duration 4 h exactly (460,800,044 bytes).
- Wall 288.0 s, RTF 0.0200 (4.8 min), CPU 287.1 s (the single CPU quota was saturated; 190.6 s of CFS throttling).
- Anon peak 100.3 MB (idle baseline 39.9 MB at start, 56.0 MB idle after the job). FFmpeg child peak RSS 57.3 MB, one FFmpeg process at a time, pids peak 35 of 64.
- cgroup `memory.peak` 512 MB, i.e. the container limit, with page cache (`file`) at 454 MB. All jobs succeeded and no leftover `.tmp-*` directory remained;
  OOM kill counters (`memory.events`) were not sampled, so absence of OOM events is inferred from the jobs completing, not measured directly.

## Memory gate (D-2B-20 is the user's decision)

`memory.peak` is not usable for the plan's 384 MB gate: it reached the 512 MB limit for the 30 min WAV and the 4 h FLAC although the
anonymous memory of the same jobs was 88 MB and 100 MB. The difference is reclaimable page cache from reading the input and writing the output.
The gate should use the **anonymous memory peak** (sampled at 10 Hz) of the container, optionally with `memory.current`/`memory.peak` reported alongside
but not gated. Measured anon peaks are 54 to 100 MB for all cases except the 8-channel 192 kHz case (169.7 MB; FFmpeg child 99.8 MB), so every case is below 384 MB by anon
and the five-job series shows no growth. This is a measurement and a recommendation only; the definition of the gate remains an open user decision.

## Not measurable here, or limits of these numbers

- One run per case (series: five), no confidence intervals. Host load (swap in use, other apps) affects wall time and RTF; none of the tests was run under a controlled idle host.
- 10 Hz sampling can miss sub-100 ms excursions of anon memory.
- Docker Desktop VM memory pressure per case is not available; only the VM process RSS before/after each case is in `results.json`.
- OOM events, page-fault and I/O pressure counters were not recorded.
- The sidecar approach needs a Docker Desktop VM that exposes `/sys/fs/cgroup`; other hosts may differ.
- Quality of the synthetic corpus: noise-like signals exercise decoding, resampling, loudness and measurement cost, not speech content.

## Reproduce

`pnpm bench:phase2b:resources` (all cases, about 12 minutes, writes about 4 GB of fixtures under the scratch root, override with
`P2B_RES_ROOT`) or `node services/audio/benchmarks/resources/run.mjs --cases mono16k-10s,stereo48k-4h-flac --out <dir>`.
