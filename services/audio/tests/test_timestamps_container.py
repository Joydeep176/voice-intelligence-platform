"""Timestamp validation (plan §11.3, acceptance §14) with tone bursts at known sample positions.

Lossless formats must place every onset on the canonical timeline within 1 ms and report `exact`
(mandatory). Lossy formats are measured, must be `offset_applied` or `approximate`, and the bound
they report must contain the measured error on the source timeline. Damaged files must be
`uncertain`, with gaps at the right positions and `decodedUntilMs` equal to what actually decodes.
The same cases feed `benchmarks/timestamps/run.py`, which writes the measured table to
`docs/development/phase2b-timestamps/`.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
import timestamp_lab as lab

from audio_service.domain.runner import SandboxRunner

pytestmark = pytest.mark.container


@pytest.fixture(scope="module")
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")
    r.verify_enforcement()
    yield r
    r.close()


# -- lossless: mandatory --------------------------------------------------------------------

WAV_GRID = [
    (depth, rate, channels)
    for depth in ("s16", "s24", "s32", "f32")
    for rate in lab.LOSSLESS_RATES
    for channels in (1, 2)
]
FLAC_GRID = [
    (depth, rate, channels)
    for depth in ("s16", "s24")
    for rate in lab.LOSSLESS_RATES
    for channels in (1, 2)
]


@pytest.mark.parametrize(("depth", "rate", "channels"), WAV_GRID)
def test_wav_onsets_are_within_one_millisecond_and_the_mapping_is_exact(
    runner: SandboxRunner, tmp_path: Path, depth: str, rate: int, channels: int
) -> None:
    row = lab.lossless_case(runner, tmp_path, "wav", rate, channels, depth)
    assert row["burstsFound"] == 2
    assert row["maxAbsOnsetErrorMs"] <= 1.0, row["onsetErrorMs"]
    assert row["mappingStatus"] == "exact", row["reasons"]
    assert row["decodeClass"] == "full" and row["decodeErrors"] == 0 and row["gaps"] == []
    assert row["canonicalSamples"] == 32000  # decoded count is the duration; nothing padded
    assert row["decodedSamplesNative"] == rate * 2


@pytest.mark.parametrize(("depth", "rate", "channels"), FLAC_GRID)
def test_flac_onsets_are_within_one_millisecond_and_the_mapping_is_exact(
    runner: SandboxRunner, tmp_path: Path, depth: str, rate: int, channels: int
) -> None:
    row = lab.lossless_case(runner, tmp_path, "flac", rate, channels, depth)
    assert row["burstsFound"] == 2
    assert row["maxAbsOnsetErrorMs"] <= 1.0, row["onsetErrorMs"]
    assert row["mappingStatus"] == "exact", row["reasons"]
    assert row["canonicalSamples"] == 32000 and row["decodedSamplesNative"] == rate * 2


# -- lossy: measured, bound must contain the error ------------------------------------------

OFFSET_FORMATS = {"m4a_aac", "ogg_vorbis", "ogg_opus", "webm_opus"}
LOSSY_CASES = [(r, 0.0) for r in lab.LOSSY] + [
    (r, 0.5) for r in lab.LOSSY if r.name in OFFSET_FORMATS
]


@pytest.mark.parametrize(
    ("recipe", "offset"), LOSSY_CASES, ids=lambda v: v.name if hasattr(v, "name") else f"+{v}s"
)
def test_lossy_status_is_honest_and_its_bound_contains_the_measured_error(
    runner: SandboxRunner, tmp_path: Path, recipe: lab.LossyRecipe, offset: float
) -> None:
    row = lab.lossy_case(runner, tmp_path, recipe, offset)
    assert row["burstsFound"] == 2
    assert row["mappingStatus"] in ("offset_applied", "approximate"), row["reasons"]
    assert row["mappingStatus"] != "exact"
    assert row["boundContainsError"], (row["onsetErrorOnSourceMs"], row["mappingErrorBoundMs"])
    assert row["decodeClass"] == "full" and row["decodeErrors"] == 0
    if offset:  # a carried leading offset must be visible in the declared source offset
        assert abs(row["sourceOffsetMs"] - 500.0) < 30.0, row["sourceOffsetMs"]


def test_mp3_without_gapless_data_is_approximate_not_offset_applied(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    recipe = next(r for r in lab.LOSSY if r.name == "mp3_cbr_no_xing")
    row = lab.lossy_case(runner, tmp_path, recipe, 0.0)
    assert row["mappingStatus"] == "approximate" and "lossy_no_gapless_info" in row["reasons"]
    assert 20.0 < row["maxAbsErrorOnSourceMs"] < row["mappingErrorBoundMs"]  # ~one MP3 frame


# -- damaged --------------------------------------------------------------------------------


def test_pcm_timestamp_gap_is_filled_and_listed_at_the_right_position(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    row = lab.damaged_gap_case(runner, tmp_path, "pcm_s16le")
    assert row["mappingStatus"] == "uncertain" and "timestamp_gaps" in row["reasons"]
    assert len(row["gaps"]) == 1
    assert abs(row["gapStartErrorMs"]) <= 10 and abs(row["gapDurationErrorMs"]) <= 10
    assert row["decodedUntilMs"] == pytest.approx(5000.0, abs=1.0)  # 4 s of audio + 1 s filled
    assert row["onsetsMs"][1] == pytest.approx(4000.0, abs=1.0)  # the later burst is re-aligned


def test_opus_timestamp_gap_position_is_within_one_packet(
    runner: SandboxRunner, tmp_path: Path
) -> None:
    """The encoder's delay and 20 ms framing blur where in a packet the jump lies."""
    row = lab.damaged_gap_case(runner, tmp_path, "libopus")
    assert row["mappingStatus"] == "uncertain" and len(row["gaps"]) == 1
    assert abs(row["gapStartErrorMs"]) <= 30 and abs(row["gapDurationErrorMs"]) <= 10
    assert row["onsetsMs"][1] == pytest.approx(4007.5, abs=1.0)  # 4 s + 7.5 ms Opus pre-skip


@pytest.mark.parametrize("codec", ["pcm_s16le", "libopus"])
@pytest.mark.parametrize("dropped", [1, 3, 10])
def test_dropped_packets_become_listed_gaps_and_the_timeline_stays_aligned(
    runner: SandboxRunner, tmp_path: Path, codec: str, dropped: int
) -> None:
    row = lab.damaged_gap_case(runner, tmp_path, codec, drop=dropped)
    assert row["mappingStatus"] == "uncertain" and "timestamp_gaps" in row["reasons"]
    assert len(row["gaps"]) == 1
    assert abs(row["gapStartErrorMs"]) <= 10 and abs(row["gapDurationErrorMs"]) <= 10
    offset = 7.5 if codec == "libopus" else 0.0
    assert row["onsetsMs"][1] == pytest.approx(3000.0 + offset, abs=1.0)  # later audio not shifted


# Formats whose truncation FFmpeg's tools can reveal (declared length, frame count, a cut-off
# packet or frame): the status must be `uncertain`.
DETECTABLE = {"wav_pcm_s16", "flac", "mp3_cbr_lame", "mp3_vbr_xing", "m4a_aac", "webm_opus"}


def test_truncated_tails(runner: SandboxRunner, tmp_path: Path) -> None:
    rows = lab.truncated_cases(runner, tmp_path)
    assert {r["format"] for r in rows} >= DETECTABLE
    for row in rows:
        # decodedUntilMs equals what plain FFmpeg decodes, whatever the status. Allowance 8 ms:
        # plain FFmpeg drops samples before pts 0 (the 7 ms Opus lead-in in Matroska) while the
        # canonical pass keeps them (`first_pts=0`); the offset and the onsets account for it.
        assert abs(row["decodedUntilErrorMs"]) <= 8.0, row
        assert row["decodedUntilMs"] < 1400  # about 60 % of 2 s: never padded back to the header
        assert row["mappingStatus"] != "exact" or row["format"] == "wav_pcm_s16"
        if row["format"] in DETECTABLE:
            assert row["mappingStatus"] == "uncertain", (row["format"], row["reasons"])
            assert row["decodeClass"] == "partial" or "corrupt_packets" in row["reasons"]
        else:  # nothing in the file says it ended early: honest limitation, recorded in the docs
            assert row["mappingStatus"] in ("approximate", "offset_applied"), row


def test_corrupted_bytes_mid_file(runner: SandboxRunner, tmp_path: Path) -> None:
    for row in lab.corrupted_cases(runner, tmp_path):
        assert row["mappingStatus"] == "uncertain", (row["format"], row["reasons"])
        assert row["decodeErrors"] > 0 and "decoder_errors" in row["reasons"]
        # C tracks presentation time, so silence `aresample` inserts for frames the decoder dropped
        # makes it at least as long as a plain decode (which just skips them): measured up to 70 ms.
        decoded = row["decodedUntilMs"] or 0.0
        assert row["oracleDecodedMs"] - 8.0 <= decoded <= row["oracleDecodedMs"] + 100.0, row
