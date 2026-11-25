# Phase 2B WS3 verification record (probe, streamed decode, timeline)

Measured on 2026-11-21 in the audio image built from `services/audio/Dockerfile` (Docker Desktop Engine 29.9.3,
linux/arm64, FFmpeg 7.1.5-0+deb13u1, Landlock ABI 8 enforced). Reproduce with `pnpm audio:test:container` (the tests
print the `HEADER_ONLY_*`, `HUGE_*`, `WAV_*`, `FUZZ_OUTCOMES` and `DECODE_1H_*` lines with `-s`) and
`benchmarks/timestamps/run.py` (see `docs/development/phase2b-timestamps/README.md` for the timestamp numbers).
No secrets, recordings or provider output are recorded; every fixture is synthetic.

## FFmpeg behaviours that shaped the code

| Finding | Consequence |
| --- | --- |
| `-codec_whitelist` is matched against **decoder** names: with `mp3` alone the `mp3float` decoder is refused | `media_args.CODEC_WHITELIST` lists both; one constant |
| With an audio-only whitelist, **ffprobe fails** (exit 1, "Codec ... not on whitelist") on any file that also has a video stream, including attached cover art (ordinary tagged MP3/M4A). `ffmpeg -vn` decoding is not fatal | `mjpeg` and `png` are admitted for cover art only; a real video track (mpeg4, h264, ...) is refused as UNSUPPORTED_FORMAT. **Corrected (review remediation):** the earlier claim "never decoded (`-vn`)" was wrong. `-vn` applies to the ffmpeg decode passes' output only: `avformat_find_stream_info` opens the decoder of the attached picture, so ffprobe does parse a cover image (measured, `VERIFICATION_REMEDIATION.md` section 4). That exposure is a residual risk contained by Landlock, rlimits, `-max_alloc` and the cgroup, not removed. This **deviates from plan §6.1** ("audio decoders only") and is a product limit: MP4 files with a real video track are rejected |
| `-allowed_media_types` is an HTTP-protocol option in 7.1.5, not a demuxer option | not usable to drop video streams |
| `-enable_drefs` / `-use_absolute_path` fail with "Option not found" for non-MOV demuxers | applied only when the forced demuxer is `mov` |
| `-format_whitelist` accepts the plan's list with `-f mov` / `-f matroska` (the demuxer's alias names) | list unchanged |
| Children share the descriptor's **file offset**; after one child reads the file, the next starts at EOF | `rewind(fd)` (`lseek 0`) before every invocation; sniffing uses `pread` |
| `-show_entries` selects ffprobe fields explicitly | container tags never appear in the output; only presence of the `iTunSMPB` key is requested (MOV) |
| `-read_intervals "%+#8,<t>%"` reads the first packets and the last second without scanning the file | priming (`Skip Samples`) and end padding (`discard_padding`) for the probe result |
| MP3 LAME/Xing: first packet carries `skip_samples` 1105, last `discard_padding`; stream `start_time` = 25.057 ms equals the priming although the decoder removes it | `sourceOffsetMs` subtracts trimmed priming (onset error 0.000 ms measured) |
| Matroska Opus: `start_time` -7 ms, no skip side data; the 7 ms lead-in stays in the decode | offset -7 ms, status `approximate` |
| `aresample=...:async=1` fills timestamp gaps larger than `min_hard_comp` (default 0.1 s); 20 ms and one dropped Opus packet are filled with `min_hard_comp=0.02` | `CANONICAL_FILTER` |
| `-loglevel error` hides the warning "Packet corrupt" of a cut-off WAV packet, but ffprobe flags the packet `K_C` | scan counts the `C` flag (`corrupt_packets`) |
| Vorbis block switching makes pts deltas differ from packet durations by up to ~448 samples | gap tolerance of one long block for Vorbis |
| `ffprobe` duration of a truncated WAV is estimated from the file size (the declared size is not exposed) | detectable only via the corrupt-packet flag |
| An MP3 without Xing/LAME data has only an estimated header duration (1839 ms for 2000 ms of VBR) | not used as the expected extent |

## Hostile-media pass criteria (`tests/test_malicious_media_container.py`)

The canary lives in another workspace's `recordings/` directory with an access time two days old. Each case runs
**unconfined** (`SandboxRunner("off")`, so only the absence of any attempt keeps the access time unchanged) and under
Landlock; a control test shows that a plain read does move the access time.

| Case (§6.4) | Result (code returned; unconfined and under Landlock identical) |
| --- | --- |
| HLS playlist / HLS key URI / DASH manifest / `ffconcat` list / `subfile:` / `file:` / image-sequence pattern text / PNG / HTML under `.wav`/`.mp3` names | UNSUPPORTED_FORMAT before any FFmpeg process starts (no signature matches); the file name is never consulted |
| Valid WAV named `frame%03d.wav` with numbered siblings | probes as `wav`; siblings' access times unchanged |
| MP4 with `alis` data reference, absolute path | CORRUPT_MEDIA (external data refused); canary untouched |
| MP4 with `alis` reference walking up to another workspace's directory | CORRUPT_MEDIA; canary untouched |
| MP4 with a `url ` reference | probes normally (FFmpeg skips the type); canary untouched |
| **Sensitivity controls** | the same hostile files **do** read the canary when FFmpeg gets a path and `-enable_drefs 1` (relative) or `-enable_drefs 1 -use_absolute_path 1` (absolute); a plain `cat` moves the access time; Landlock denies a confined `cat`. Mutation: loosening `-enable_drefs`, `-use_absolute_path` and the protocol whitelist together made the test fail with "the canary was read"; dropping `-codec_whitelist` made the real-video test fail |
| WAV + MP4 polyglot (RIFF header first, `alis` MP4 appended) | probes as `wav`; MOV never parses it; canary untouched |
| MP4 whose `ftyp` is first with a RIFF tail | probes as `mp4` |
| `file:`/`subfile,`/`concat:` strings and private titles in ID3, MP4, WAV, FLAC and Ogg metadata | probes normally; none of the strings in the result; canary untouched |
| 20 MB ID3v2 tag (sparse) before valid MP3 frames, and with nothing after it | bounded; a tag text never appears in the result |
| Zero-length / WAV cut inside the header (4, 11, 20, 30 bytes) | CORRUPT_MEDIA |
| Header-only WAV, FLAC, MP3, Ogg | CORRUPT_MEDIA |
| MP3 bytes under an `OggS` or `RIFF/WAVE` header | a mapped code (no crash) |
| WAV declaring a 4 GB data chunk with 4 KB present | probes (ffprobe clamps to the file); only the real extent is decoded |
| MP4 with enormous `mdhd`/`mvhd`/`stts`/`elst` durations; FLAC declaring 2^36 samples | DURATION_LIMIT_EXCEEDED; no decoding |
| 255-channel WAV header; 768 kHz WAV header | RESOURCE_LIMIT_EXCEEDED |
| Probe timeout (`PROBE_TIMEOUT_S` forced to 0) | TIMEOUT; no `ffprobe`/`ffmpeg` process left in `/proc` |
| Stalled consumer / slow decode (`StreamedDecoder`) | TIMEOUT in under 10 s with the child killed; cancellation latency 2.1 s (the runner's SIGTERM grace: the child is blocked writing to the full pipe) |
| 50 seeded mutations (seed 20261121; 10 each of WAV, MP3, M4A, FLAC, Ogg; flips, header edits, truncation, insertion, zeroing) | 28 probed, 17 CORRUPT_MEDIA, 4 NO_DECODABLE_AUDIO, 1 UNSUPPORTED_FORMAT, 0 other; slowest 0.20 s; canary untouched; SHA-256 unchanged; no process left |
| Logs | a failing and a damaged file probed with the root logger at DEBUG: no stderr fragment, tag text or canary path in any log record |

Other measurements: decoding a 1 h mono file (115 MB of PCM, two passes) grew the Python process by 2.0 MB peak RSS;
the packet scan of a 4 h file (225 000 packets, 230 MB) took 1.3 s with no measurable growth.

## Not verified

- Other kernels and Landlock-less hosts (the unconfined runs exercise that case only for the canary tests).
- Performance on a real 4 h recording or the 384 MB `memory.peak` acceptance figure (WS9 benchmark).
- Compose-mounted `/storage` paths (the test container has no `/storage`).
- Truncation that nothing in the file reveals (Ogg, MP3 without Xing): the record is not `uncertain`; see
  `docs/development/phase2b-timestamps/README.md`.
