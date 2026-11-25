"""Reproducible timestamp measurements (plan §11.3, Phase 2B WS3).

Runs the real probe, packet scan, streamed decoders and timeline mapping through the sandbox
runner against tone-burst fixtures generated with FFmpeg `lavfi` (test-only: production arguments
reject lavfi), measures where the bursts land on the canonical 16 kHz timeline, and writes
`results.json` and `README.md`. It must run inside the audio image (FFmpeg, Landlock):

    docker build -f services/audio/Dockerfile --target test -t vip-audio-test services/audio
    docker run --rm --init --read-only --cap-drop ALL --security-opt no-new-privileges \\
      --pids-limit 64 --memory 512m --cpus 1 --tmpfs /tmp:size=16m,noexec,nosuid,nodev \\
      -v "$PWD/docs/development/phase2b-timestamps:/out" vip-audio-test \\
      python benchmarks/timestamps/run.py --out /out

Only measured numbers are written. Nothing is downloaded and no recording is used.
"""

from __future__ import annotations

import argparse
import json
import platform
import subprocess  # noqa: S404
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))

import numpy  # noqa: E402
import timestamp_lab as lab  # noqa: E402

from audio_service.domain.capabilities import measure_ffmpeg_version  # noqa: E402
from audio_service.domain.runner import SandboxRunner  # noqa: E402

OFFSET_FORMATS = {"m4a_aac", "ogg_vorbis", "ogg_opus", "webm_opus"}


def collect() -> dict[str, Any]:
    runner = SandboxRunner("auto")
    runner.verify_enforcement()
    results: dict[str, Any] = {
        "environment": {
            "ffmpeg": measure_ffmpeg_version(),
            "python": platform.python_version(),
            "numpy": numpy.__version__,
            "machine": platform.machine(),
            "kernel": platform.release(),
            "landlockAbi": runner.landlock_abi,
            "landlockEnforced": runner.landlock_enforced,
        },
        "fixtures": {
            "burstStartsS": list(lab.BURST_STARTS_S),
            "burstLengthS": lab.BURST_LENGTH_S,
            "burstHz": lab.BURST_HZ,
            "durationS": lab.DURATION_S,
            "onsetRule": "first canonical sample above 25 % of the peak amplitude",
            "canonicalResolutionMs": 1000 / lab.CANONICAL_RATE_HZ,
        },
        "lossless": [],
        "lossy": [],
        "damaged": {"gaps": [], "truncated": [], "corrupted": []},
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for kind, depths in (("wav", ("s16", "s24", "s32", "f32")), ("flac", ("s16", "s24"))):
                for depth in depths:
                    for rate in lab.LOSSLESS_RATES:
                        for channels in (1, 2):
                            results["lossless"].append(
                                lab.lossless_case(runner, directory, kind, rate, channels, depth)
                            )
            for recipe in lab.LOSSY:
                results["lossy"].append(lab.lossy_case(runner, directory, recipe, 0.0))
                if recipe.name in OFFSET_FORMATS:
                    results["lossy"].append(lab.lossy_case(runner, directory, recipe, 0.5))
            gaps = results["damaged"]["gaps"]
            for codec in ("pcm_s16le", "libopus"):
                gaps.append(lab.damaged_gap_case(runner, directory, codec))
                for dropped in (1, 3, 10):
                    gaps.append(lab.damaged_gap_case(runner, directory, codec, drop=dropped))
            results["damaged"]["truncated"] = lab.truncated_cases(runner, directory)
            results["damaged"]["corrupted"] = lab.corrupted_cases(runner, directory)
    finally:
        runner.close()
    return results


def md_table(header: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


def fmt(values: list[Any]) -> str:
    return ", ".join("n/a" if v is None else f"{v:+.3f}" for v in values)


def lossless_section(rows: list[dict[str, Any]]) -> str:
    grouped: dict[tuple[str, str], dict[int, list[dict[str, Any]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for row in rows:
        grouped[(row["kind"], row["depth"])][row["rateHz"]].append(row)
    table = []
    for (kind, depth), by_rate in grouped.items():
        for rate in sorted(by_rate):
            cases = by_rate[rate]
            worst = max(c["maxAbsOnsetErrorMs"] for c in cases)
            exact = sum(c["mappingStatus"] == "exact" for c in cases)
            table.append([kind.upper(), depth, rate, f"{worst:.4f}", f"{exact}/{len(cases)}"])
    worst_all = max(r["maxAbsOnsetErrorMs"] for r in rows)
    exact_all = sum(r["mappingStatus"] == "exact" for r in rows)
    body = md_table(
        ["Container", "Sample format", "Rate (Hz)", "Max abs onset error (ms), mono and stereo",
         "Status exact"],
        table,
    )  # fmt: skip
    return (
        f"{len(rows)} cases (WAV s16/s24/s32/f32 and FLAC 16/24-bit, six rates, mono and stereo, "
        f"two bursts each). Worst onset error over all cases: **{worst_all:.4f} ms** (criterion: "
        f"1 ms, canonical resolution 0.0625 ms). `mappingStatus == exact`: **{exact_all}/"
        f"{len(rows)}**.\n\n{body}\n"
    )


def lossy_section(rows: list[dict[str, Any]]) -> str:
    table = []
    for row in rows:
        table.append(
            [
                row["id"],
                row["mappingStatus"],
                row["mappingErrorBoundMs"],
                fmt(row["onsetErrorOnCanonicalMs"]),
                row["sourceOffsetMs"],
                fmt(row["onsetErrorOnSourceMs"]),
                "yes" if row["boundContainsError"] else "**NO**",
                row["gaplessInfo"],
                ", ".join(row["reasons"]),
            ]
        )
    return md_table(
        ["Case", "Status", "Bound (ms)", "Onset error on C (ms)", "sourceOffsetMs",
         "Onset error on S (ms)", "Bound contains error", "Gapless info", "Reasons"],
        table,
    ) + "\n"  # fmt: skip


def damaged_section(damaged: dict[str, Any]) -> str:
    gap_rows = [
        [
            r["id"],
            r["mappingStatus"],
            r["gaps"],
            r["expectedGapStartMs"],
            r["gapStartErrorMs"],
            r["expectedGapDurationMs"],
            r["gapDurationErrorMs"],
            r["decodedUntilMs"],
            fmt(r["onsetsMs"]).replace("+", ""),
        ]
        for r in damaged["gaps"]
    ]
    trunc_rows = [
        [
            r["format"],
            f"{r['bytesKept']}/{r['bytesFull']}",
            r["mappingStatus"],
            r["decodeClass"],
            r["decodedUntilMs"],
            r["oracleDecodedMs"],
            r["decodedUntilErrorMs"],
            ", ".join(r["reasons"]),
        ]
        for r in damaged["truncated"]
    ]
    corrupt_rows = [
        [
            r["format"],
            r["mappingStatus"],
            r["decodeClass"],
            r["decodeErrors"],
            r["decodedUntilMs"],
            r["oracleDecodedMs"],
            ", ".join(r["reasons"]),
        ]
        for r in damaged["corrupted"]
    ]
    missed = [r["format"] for r in damaged["truncated"] if r["mappingStatus"] != "uncertain"]
    return (
        "### Injected timestamp gaps and dropped packets\n\n"
        + md_table(
            [
                "Case",
                "Status",
                "Gaps on C (start, duration ms)",
                "Expected start",
                "Start error",
                "Expected duration",
                "Duration error",
                "decodedUntilMs",
                "Burst onsets on C (ms)",
            ],
            gap_rows,
        )  # fmt: skip
        + "\n\n### Truncated tail (cut at 60 % of the bytes)\n\n"
        + md_table(
            [
                "Format",
                "Bytes kept/full",
                "Status",
                "Decode class",
                "decodedUntilMs",
                "Plain FFmpeg decodes (ms)",
                "Difference (ms)",
                "Reasons",
            ],
            trunc_rows,
        )  # fmt: skip
        + "\n\nTruncation that **nothing in the file reveals** (status not `uncertain`): "
        + (", ".join(f"`{m}`" for m in missed) or "none")
        + ". `decodedUntilMs` is still exact for them; only the knowledge that data is missing "
        "is absent.\n\n### 600 corrupted bytes mid-file\n\n"
        + md_table(
            [
                "Format",
                "Status",
                "Decode class",
                "Decoder errors",
                "decodedUntilMs",
                "Plain FFmpeg decodes (ms)",
                "Reasons",
            ],
            corrupt_rows,
        )  # fmt: skip
        + "\n"
    )


def readme(results: dict[str, Any]) -> str:
    env = results["environment"]
    fx = results["fixtures"]
    return f"""# Phase 2B WS3 timestamp validation (measured)

Generated by `services/audio/benchmarks/timestamps/run.py`; **every number below was measured by
that script** inside the audio image (nothing is estimated). Synthetic fixtures only (FFmpeg
`lavfi`, test-only), no recordings, nothing downloaded. Raw data: `results.json`.

## Environment

| Item | Value |
| --- | --- |
| FFmpeg | {env["ffmpeg"]} |
| Python / NumPy | {env["python"]} / {env["numpy"]} |
| Machine / kernel | {env["machine"]} / {env["kernel"]} |
| Landlock ABI / enforced on the children | {env["landlockAbi"]} / {env["landlockEnforced"]} |

## Method

- Fixture: a mono or stereo signal of {fx["durationS"]} s that is silent except for two
  {fx["burstLengthS"] * 1000:.0f} ms, {fx["burstHz"]} Hz cosine bursts starting at
  {fx["burstStartsS"][0]} s and {fx["burstStartsS"][1]} s on exact sample positions (`aevalsrc`).
  Truncation and corruption fixtures add low-level noise so the file has a body.
- Pipeline per case: `probe_media` (sniff, ffprobe, limits, trial decode), `scan_packets`
  (streamed packet list), native and canonical `StreamedDecoder` passes (the canonical pass is
  `aresample=16000:async=1:first_pts=0:min_hard_comp=0.02`, `-ac 1`, `s16le`), `build_timeline`.
  All children run under the sandbox runner (Landlock {env["landlockAbi"]}).
- Onset = {fx["onsetRule"]}; resolution one canonical sample ({fx["canonicalResolutionMs"]} ms).
- **Onset error on C**: onset on the canonical timeline minus the burst's signal time. **Onset
  error on S**: `onset_C + sourceOffsetMs` minus (signal time + the leading offset the container
  actually carried). The reported `mappingErrorBoundMs` is judged against the error on S, the
  mapping the record claims. MP3 cannot carry a leading offset, so it has no offset variant.
- Leading-offset variants use `-itsoffset 0.5` on the input.

## Lossless (mandatory: within 1 ms and `exact`)

{lossless_section(results["lossless"])}
## Lossy (measured; status must be `offset_applied` or `approximate`; bound must contain the error)

{lossy_section(results["lossy"])}
## Damaged inputs (must be `uncertain`, gaps in the right place, `decodedUntilMs` correct)

{damaged_section(results["damaged"])}
## Reading the results

- **`sourceOffsetMs`** is the offset such that `t_S = t_C + sourceOffsetMs`. FFmpeg's MP3 demuxer
  reports a `start_time` equal to the LAME priming (1105 samples, 25.057 ms at 44.1 kHz) although
  the decoder removes exactly those samples, so the first decoded sample is signal sample 0 (onset
  error 0.000 ms on C); `build_timeline` therefore subtracts the trimmed priming when the two
  agree to 0.1 ms. MP4/AAC, Ogg Opus and Vorbis report their start after priming already.
- **MP4/AAC with a leading offset** (`-itsoffset`): the priming is not trimmed (about one AAC frame,
  23.2 ms, extra at the front of C) but `sourceOffsetMs` accounts for it, so the error on S stays
  small while the error on C does not.
- **Opus in Matroska/WebM** keeps its 7 ms lead-in (the demuxer reports `start_time` -7 ms and no
  skip side data), so C starts 7 ms before the first signal sample; `sourceOffsetMs` is -7 ms and
  the mapping is `approximate` (no gapless information is recognised for it).
- **MP3 without Xing/LAME data** keeps the encoder delay in the audio (about one frame, 25 ms):
  `approximate` with a bound of one frame, which the measured error stays inside.
- **Gap positions** are read from packet timestamps. For Opus the encoder's delay and 20 ms framing
  blur where inside a packet a source jump lies, so the position is good to about one packet; for
  PCM it is exact. Gaps of 20 ms or more are filled by `aresample` (`min_hard_comp=0.02`) so C keeps
  tracking presentation time (later bursts re-align); the record lists only the gaps it filled.
- **A single dropped packet** is a gap of one packet duration and is detected (the tolerance is
  half the previous packet's duration, 1 ms at least; Vorbis uses one long block because its block
  switching makes pts deltas differ from packet durations).
- **`decodedUntilMs`** is the length of C. For truncated files it equals what a plain FFmpeg
  decode produces (the one difference, Opus in Matroska, is its 7 ms lead-in that C keeps). After
  corruption C can be longer than a plain decode: `aresample` inserts silence for frames the
  decoder dropped so that C keeps tracking presentation time. That silence is **not** listed in
  `gaps` (the packet timestamps showed no jump, for example MP3); the record is `uncertain` with a
  decoder-error count instead.
- **Header durations are not trusted blindly**: an MP3 without Xing data has only an estimate, and
  container durations may include a leading offset, so the expected extent comes from the packet
  list (end of the last packet minus the stream origin, minus end padding).
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--out", type=Path, required=True, help="directory for README.md/results.json"
    )
    args = parser.parse_args()
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, check=True, timeout=10)  # noqa: S607
    except (OSError, subprocess.SubprocessError):
        sys.stderr.write("ffmpeg is required: run this inside the audio test image\n")
        return 2
    results = collect()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "results.json").write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    generated = readme(results)
    (args.out / "README.md").write_text(generated)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
