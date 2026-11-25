# Phase 2B WS4 verification record (measurements, canonical WAV, `preprocess` task)

Measured on 2026-11-21 in the audio image built from `services/audio/Dockerfile` (Docker Desktop Engine 29.9.3,
linux/arm64, FFmpeg 7.1.5-0+deb13u1, Python 3.12.16, NumPy 2.5.5, Landlock ABI 8 enforced; container flags of
`pnpm audio:test:container`: read-only root, `--cap-drop ALL`, `--memory 512m`, `--cpus 1`, 16 MB tmpfs). Every input is
synthetic. No new dependency (NumPy only). Waveform peaks, VAD and segmentation are not built (OD-39, OD-29).

## Test counts

| Command | Result |
| --- | --- |
| `pnpm audio:lint` (ruff check, ruff format --check, mypy strict) | all passed; 69 files formatted, 29 source files typed |
| `pnpm audio:test` (host) | 484 passed, 206 skipped (container/Docker-only tests) |
| `pnpm audio:test:container` | 681 passed, 9 skipped (7 need `AUDIO_SERVICE_TEST_DOCKER=1`, 1 needs `/storage`, 1 is the manual 60-minute test) |
| `pnpm --filter @vip/contracts build && ... test` | build ok; 2 files, 93 tests passed |
| `pnpm typecheck`, `pnpm lint` | 7 of 7 tasks successful each |

New tests: `tests/test_measurements.py` (35, host, analytic signals), `tests/test_preprocess_unit.py` (46, host, scripted
FFmpeg), `tests/test_preprocess_parts.py` (loudness parsing, WAV writer, storage digest and verified reads),
`tests/test_preprocess_container.py` (25 in the image + the manual long test), contract fixtures (both suites).

## Canonical JSON and config hash (identical in Python and TypeScript)

`configHash` = lower-case hex SHA-256 of the UTF-8 bytes of the canonical JSON of the config, which is the last segment
of `outputPrefix` (`derived/<ws>/<rec>/<configHash>`). Canonical JSON: object keys sorted recursively by code point (all
keys of this schema are ASCII), no whitespace between tokens, strings JSON-escaped with non-ASCII left as is, numbers only
as integers (safe-integer range); floats, booleans and null are rejected (`ValueError` / thrown `Error`). Python:
`contracts.canonical_json` and `config_hash`; TypeScript: `canonicalJson` (pure, no `node:crypto`, because the module is
browser-shared; the coordinator hashes with `node:crypto`). Shared vectors `preprocess-config-hash.*.valid.json`
(`{config, canonicalJson, expectedHash}`: default, different limits and tool versions, reordered keys with the same
hash) are checked by both suites for the exact string and the exact hash. All config numbers are integers: dBFS in
hundredths (`silenceThresholdCentiDbfs: -5000`), times in milliseconds.

## Accuracy on analytic signals (real FFmpeg decode, container)

| Signal | Quantity | Expected | Measured | Error |
| --- | --- | --- | --- | --- |
| 1 kHz sine, amplitude 1.0, float32 WAV, 48 kHz | peak dBFS | 0.0000 | 0.0000 | 0.0000 |
| | RMS dBFS | -3.0103 | -3.0100 | +0.0003 |
| | crest factor dB | 3.0103 | 3.0100 | -0.0003 |
| | clipped samples (`|x| >= 1.0`) | 2000 | 2000 | 0 |
| | integrated loudness LUFS | -3.01 | -3.00 | +0.01 (FFmpeg prints one decimal) |
| | true peak dBTP | 0.0 | 0.0 | 0.0 |
| | canonical (16 kHz) RMS dBFS | -3.0103 | -3.0100 | +0.0003 |
| sine, amplitude 0.5, s16, 48 kHz | peak / RMS dBFS | -6.0206 / -9.0309 | -6.0210 / -9.0310 | -0.0004 / -0.0001 |
| full-scale square wave, s16, 400 periods | clipped samples / runs / longest run | 8000 / 800 / 10 | 8000 / 800 / 10 | 0 |
| DC 8192/32768, s16 | DC offset / RMS dBFS | 0.25 / -12.0412 | 0.25 / -12.0410 | 0 / +0.0002 |
| white noise sigma 0.1, seed 20261121 | RMS dBFS (native / canonical) | -19.9975 / -19.9973 | -19.9970 / -19.9970 | +0.0005 / +0.0003 |
| stereo identical / inverted / independent | correlation | 1 / -1 / 0 | 1 / -1 / 0.0016 | 0 / 0 / 0.0016 |

Values are rounded when serialised (dB to 3 decimals, linear to 9), so the errors above include that rounding. The
loudness expectation matters: BS.1770 is calibrated so that a 0 dBFS 1 kHz sine reads its mean-square level (-3.01 LUFS);
a first test expectation of -3.7 was wrong and was corrected after the measurement, not the code.

Other container results: sources of 8, 16, 22.05, 44.1, 48, 96 and 192 kHz (mono and stereo) all produce 16 000 canonical
samples per second, `decodeClass full`, `mappingStatus exact`; the 24-bit WAV test confirms FFmpeg decodes
`pcm_s24le` as `s32` with 24 raw bits and the extreme codes are counted exactly (a code one below is not); the canonical
WAV parses with Python's `wave` module and `durationMs == samples / 16`; a truncated FLAC gives `decodeClass partial`,
`mappingStatus uncertain` and measurements covering only the decoded samples.

## Determinism, reuse, cancellation (container)

| Check | Result |
| --- | --- |
| Same input and config twice, fresh storage roots | identical result JSON, canonical SHA-256, level series, `result.json` and `manifest.json` bytes |
| Published output present | handler returns the stored result with **0** `runner.run` calls (counting runner) and, on host, without calling probe or scan |
| One byte of `canonical.wav` flipped / manifest removed / extra file in manifest / `result.json` damaged | not reused, recomputed and republished (host) |
| Config hash mismatch, tool version mismatch | `CONFIG_HASH_MISMATCH` / `TOOL_VERSION_MISMATCH` (non-retryable) before any FFmpeg process, no `derived/` directory created |
| Cancel during pass A (`decode`) and pass B (`measure`), FFmpeg throttled so the pass lasts | `TaskCancelled`; no `ffmpeg`/`ffprobe` in `/proc`; no `.tmp-*`; no manifest; the output prefix empty; latency under 10 s (the runner's SIGTERM grace) |
| HTTP end to end (`create_app(media_handlers=True)`) | task `succeeded`, result validates, last progress `write` at 1.0; wrong prefix hash fails with `{"code":"CONFIG_HASH_MISMATCH","retryable":false}`; capabilities `taskTypes == ["preprocess","probe"]`, `vad == "none"` |
| Storage write error EIO / ENOSPC / EDQUOT, publish failure, free-space precheck, byte budget (host, injected) | `STORAGE_ERROR` / `RESOURCE_LIMIT_EXCEEDED` ...; temp removed; no manifest; precheck requested `3 * (expected canonical bytes + 44)` |

## 60-minute input (manual test, `AUDIO_SERVICE_TEST_LONG_DIR`)

48 kHz stereo s16 WAV, 3600 s (691 MB), generated by the test; same hardened container flags plus a writable bind mount
(the default container has only a 16 MB tmpfs and cannot hold the 115 MB canonical output). All three passes (native,
canonical, EBU R128) and publication:

| Measurement | Value |
| --- | --- |
| Wall time | 80.4 s (first run, 96.4 s) |
| Canonical samples | 57 600 000 = 3600 x 16 000; `mappingStatus exact` |
| Python process peak RSS / growth over the pre-task value | 119.2 MB / 30.6 MB |
| Largest child (FFmpeg) peak RSS | 80.1 MB |
| Container anonymous memory peak (cgroup `memory.stat` `anon`, sampled every 0.2 s) | 107.1 MB |
| Container `memory.peak` / `memory.current` peak | 512.0 MB (the limit): dominated by reclaimable page cache from reading 691 MB and writing 115 MB; no OOM kill |

The plan's memory gate (`memory.peak <= 384 MB` on the 4 h benchmark) is **not** evaluated here: the 4 h run is a later
workstream, and `memory.peak` includes page cache, so the benchmark must decide whether to read `anon` or to drop caches
first. Block size in this run: 10 s.

## Behaviours worth knowing

- **Loudness summary and stderr cap.** The EBU R128 summary is printed at FFmpeg's `info` level, after the input dump
  (which includes container tags). The runner keeps only the first 64 KiB of stderr, so a file with an extreme amount of
  metadata can push the summary out: loudness is then `unavailable` with reason `summary_not_found`. Not reproduced with
  real files; covered by the parser tests.
- **Clipped runs are per rail.** A run of `+full scale` samples directly followed by `-full scale` samples counts as two
  runs. `clippedRuns` has unit `count` (new unit), `clippedSamples` unit `samples`.
- **Clipping rule by source type.** Integer sources: the exact extreme codes of the source bit depth (from the probe's
  sample format and raw bits); float sources: `|x| >= 1.0`. Sources of 25 to 31 bits and 32-bit integers cannot be
  distinguished from full scale in float32 near the positive rail (the threshold rounds to 1.0).
- **Digital silence.** Levels in dB are `unavailable` with reason `digital_silence`; linear values stay (0.0). The level
  series uses `null` for such windows.
- **The level series' final window** may be shorter than the interval (its RMS is over its actual samples) and is counted
  in `silenceRatio` and the noise-floor percentile.
- **Float summation across machines.** Pass A uses float64 sums through BLAS (`matmul`); results are identical across runs
  here (and rounded to 3/9 decimals), but bit-identical results on different CPU architectures are not claimed. The
  canonical pass uses exact integer sums. The image sets `OMP_NUM_THREADS=1` and `OPENBLAS_NUM_THREADS=1` (plan 4.3).
- **Unknown duration.** With neither a header duration nor a packet extent, the free-space precheck assumes the 4 h
  ceiling (3 x 460 MB).
