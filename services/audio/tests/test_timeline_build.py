"""Mapping status rules (plan §11.2): never more precision than the evidence allows."""

from __future__ import annotations

from typing import Any

import pytest

from audio_service.contracts import ProbeResult
from audio_service.domain.decoder import DecodeMode, DecodeStats
from audio_service.domain.media_args import StderrClasses
from audio_service.domain.packets import PacketScan, TimelineEvent
from audio_service.domain.runner import Outcome
from audio_service.domain.timeline import (
    ERROR_BOUND_GAPLESS_LOSSY_MS,
    ERROR_BOUND_LOSSLESS_MS,
    build_timeline,
    classify_decode,
    expected_canonical_ms,
)


def probe(**kw: Any) -> ProbeResult:
    source: dict[str, Any] = {
        "timeBase": "1/44100",
        "startTimeTicks": 0,
        "startTimeMs": 0.0,
        "editListPresent": False,
        "encoderDelaySamples": None,
        "paddingSamples": None,
        "gaplessInfo": "none",
    }
    source.update(kw.pop("source", {}))
    body: dict[str, Any] = {
        "container": "wav",
        "demuxer": "wav",
        "codec": "pcm_s16le",
        "sampleRateHz": 44100,
        "channels": 2,
        "channelLayout": None,
        "sampleFormat": "s16",
        "bitsPerRawSample": 16,
        "bitRate": None,
        "headerDurationMs": 2000,
        "streamCount": 1,
        "audioStreamCount": 1,
        "trialDecode": {"decodable": True, "decodedMs": 2000},
        "timelineSource": source,
        "warnings": [],
        "tools": {"ffprobe": "test"},
    }
    body.update(kw)
    return ProbeResult.model_validate(body)


def clean_scan(**kw: Any) -> PacketScan:
    base = {"packets": 22, "first_pts": 0, "last_end": 88200, "max_duration_ticks": 4096}
    base.update(kw)
    return PacketScan(**base)


def stats(mode: DecodeMode, rate: int, frames: int, **kw: Any) -> DecodeStats:
    kw.setdefault("returncode", 0)  # a finished, clean FFmpeg run
    return DecodeStats(mode, rate, 2 if mode is DecodeMode.NATIVE else 1, frames=frames, **kw)


def build(p: ProbeResult, scan: PacketScan | None, *, canonical_frames: int = 32000, **kw: Any):  # type: ignore[no-untyped-def]
    native = stats(DecodeMode.NATIVE, 44100, 88200)
    canonical = stats(DecodeMode.CANONICAL, 16000, canonical_frames, **kw)
    return build_timeline(p, scan, native, canonical)


def test_lossless_without_offset_gaps_or_errors_is_exact() -> None:
    t = build(probe(), clean_scan())
    assert t.mappingStatus == "exact"
    assert t.mappingErrorBoundMs == pytest.approx(ERROR_BOUND_LOSSLESS_MS)
    assert (t.decodeClass, t.decodedUntilMs, t.sourceOffsetMs) == ("full", 2000.0, 0.0)
    assert (t.nativeSampleRate, t.decodedSamplesNative, t.canonicalSamples) == (44100, 88200, 32000)
    assert t.reasons == ["lossless_no_gaps"]


def test_lossless_with_a_declared_start_offset_is_offset_applied() -> None:
    p = probe(source={"startTimeTicks": 22050, "startTimeMs": 500.0})
    t = build(p, clean_scan(first_pts=22050, last_end=22050 + 88200))
    assert t.mappingStatus == "offset_applied" and t.sourceOffsetMs == 500.0
    assert "declared_offset" in t.reasons


def test_lossless_with_unknown_start_but_zero_first_pts_is_exact() -> None:
    p = probe(source={"startTimeTicks": None, "startTimeMs": None})
    assert build(p, clean_scan()).mappingStatus == "exact"


def lossy(**source: Any) -> ProbeResult:
    base = {"timeBase": "1/44100", "startTimeTicks": 0, "startTimeMs": 0.0}
    base.update(source)
    return probe(container="mp4", demuxer="mov", codec="aac", sampleFormat="fltp", source=base)


def test_lossy_with_gapless_information_is_offset_applied_with_a_small_bound() -> None:
    p = lossy(gaplessInfo="edit_list", editListPresent=True)
    t = build(p, clean_scan())
    assert t.mappingStatus == "offset_applied"
    assert t.mappingErrorBoundMs == ERROR_BOUND_GAPLESS_LOSSY_MS


def test_lossy_without_gapless_information_is_approximate_with_one_frame_bound() -> None:
    t = build(lossy(), clean_scan(max_duration_ticks=1024))
    assert t.mappingStatus == "approximate"
    assert t.mappingErrorBoundMs == pytest.approx(1024 * 1000 / 44100, abs=0.001)
    assert "lossy_no_gapless_info" in t.reasons


def test_lossy_with_only_a_declared_offset_is_still_approximate() -> None:
    t = build(
        lossy(startTimeTicks=441, startTimeMs=10.0), clean_scan(first_pts=441, last_end=88641)
    )
    assert t.mappingStatus == "approximate" and "declared_offset" in t.reasons


@pytest.mark.parametrize(
    ("scan", "reason"),
    [
        (clean_scan(gap_count=1), "timestamp_gaps"),
        (clean_scan(overlap_count=1), "timestamp_overlaps"),
        (clean_scan(missing_pts=1), "missing_pts"),
        (clean_scan(non_monotonic=1), "non_monotonic_pts"),
        (clean_scan(corrupt_packets=1), "corrupt_packets"),
        (None, "packet_scan_unavailable"),
    ],
)
def test_damage_makes_the_status_uncertain_even_for_lossless(
    scan: PacketScan | None, reason: str
) -> None:
    t = build(probe(), scan)
    assert t.mappingStatus == "uncertain" and t.mappingErrorBoundMs is None
    assert reason in t.reasons


def test_decoder_errors_make_the_status_uncertain_and_carry_the_position() -> None:
    t = build(
        probe(),
        clean_scan(),
        errors=StderrClasses(decode_errors=3),
        first_error_frame=8000,
    )
    assert t.mappingStatus == "uncertain"
    assert t.decodeErrors.count == 3 and t.decodeErrors.firstAtMs == 500.0


def test_timestamp_compensation_failures_make_the_status_uncertain() -> None:
    t = build(probe(), clean_scan(), errors=StderrClasses(compensation_failures=1))
    assert t.mappingStatus == "uncertain" and "timestamp_compensation_failed" in t.reasons


def test_gaps_are_placed_on_the_canonical_timeline_and_small_ones_are_not_claimed_filled() -> None:
    scan = clean_scan(
        gap_count=2,
        gaps=[TimelineEvent(88200, 44100), TimelineEvent(1000, 100)],  # 1 s at 2.0 s; 2.3 ms
    )
    t = build(probe(), scan)
    assert [(g.startMs, g.durationMs, g.kind) for g in t.gaps] == [
        (2000.0, 1000.0, "timestamp_gap_filled")
    ]
    assert "timestamp_gaps_below_fill_threshold" in t.reasons


def test_gap_positions_are_relative_to_the_stream_origin_not_the_first_packet() -> None:
    # MP3-style: packet pts start at 0 but the decoded stream begins 25 ms later.
    p = probe(
        container="mp3",
        demuxer="mp3",
        codec="mp3",
        source={
            "timeBase": "1/1000",
            "startTimeTicks": 25,
            "startTimeMs": 25.0,
            "gaplessInfo": "lame",
            "encoderDelaySamples": 1100,
        },
    )
    t = build(p, clean_scan(first_pts=0, gap_count=1, gaps=[TimelineEvent(1025, 500)]))
    assert t.gaps[0].startMs == 1000.0


def test_overlaps_are_listed() -> None:
    t = build(probe(), clean_scan(overlap_count=1, overlaps=[TimelineEvent(44100, 441)]))
    assert [(o.atMs, o.durationMs) for o in t.overlapsTrimmed] == [(1000.0, 10.0)]


def test_mp3_start_time_equal_to_trimmed_priming_is_not_reported_as_an_offset() -> None:
    p = probe(
        container="mp3",
        demuxer="mp3",
        codec="mp3",
        source={
            "timeBase": "1/14112000",
            "startTimeTicks": 353600,
            "startTimeMs": 25.057,
            "gaplessInfo": "lame",
            "encoderDelaySamples": 1105,
            "paddingSamples": 551,
        },
    )
    scan = clean_scan(first_pts=0, last_end=28_753_000)  # 2000 ms of audio + priming + padding
    t = build(p, scan)
    assert t.sourceOffsetMs == 0.0 and t.source.startTimeMs == 25.057  # raw value kept in source
    assert t.mappingStatus == "offset_applied"


def test_mp3_start_time_that_is_not_the_priming_is_kept() -> None:
    p = probe(
        container="mp3",
        demuxer="mp3",
        codec="mp3",
        source={
            "timeBase": "1/1000",
            "startTimeTicks": 100,
            "startTimeMs": 100.0,
            "gaplessInfo": "lame",
            "encoderDelaySamples": 1105,
        },
    )
    assert build(p, clean_scan(first_pts=0, last_end=2100)).sourceOffsetMs == 100.0


def test_unknown_start_without_packets_cannot_be_exact() -> None:
    p = probe(source={"startTimeTicks": None, "startTimeMs": None})
    t = build(p, clean_scan(first_pts=None, last_end=None, packets=0))
    assert t.mappingStatus == "uncertain" and "source_start_unknown" in t.reasons


# -- decode class ----------------------------------------------------------------------------------


def canonical(frames: int, **kw: Any) -> DecodeStats:
    return stats(DecodeMode.CANONICAL, 16000, frames, **kw)


def test_nothing_decoded_is_none_with_no_extent() -> None:
    assert classify_decode(canonical(0), expected_ms=2000, tolerance_ms=100) == ("none", None)


def test_shorter_than_expected_is_partial_and_reports_what_was_decoded() -> None:
    assert classify_decode(canonical(19184), expected_ms=2000, tolerance_ms=100) == (
        "partial",
        1199.0,
    )


def test_within_tolerance_is_full_and_longer_is_never_trimmed() -> None:
    assert classify_decode(canonical(31000), expected_ms=2000, tolerance_ms=100)[0] == "full"
    assert classify_decode(canonical(33000), expected_ms=2000, tolerance_ms=100) == ("full", 2062.5)


def test_a_non_zero_exit_is_partial_even_when_long_enough() -> None:
    bad = canonical(32000, returncode=1)
    assert classify_decode(bad, expected_ms=2000, tolerance_ms=100)[0] == "partial"
    timed_out = canonical(32000, outcome=Outcome.TIMEOUT, returncode=None)
    assert classify_decode(timed_out, expected_ms=2000, tolerance_ms=100)[0] == "partial"


def test_unknown_expectation_is_full_when_the_decoder_exited_cleanly() -> None:
    assert classify_decode(canonical(100), expected_ms=None, tolerance_ms=100)[0] == "full"


def test_a_header_longer_than_the_data_makes_the_decode_partial_in_the_record() -> None:
    p = probe(headerDurationMs=2000)
    t = build(p, clean_scan(last_end=44100), canonical_frames=16000)  # data stops at 1 s
    assert t.decodeClass == "partial" and t.decodedUntilMs == 1000.0
    assert t.mappingStatus == "uncertain" and "partial_decode" in t.reasons


def test_an_mp3_header_estimate_without_lame_data_is_not_trusted() -> None:
    p = probe(
        container="mp3",
        demuxer="mp3",
        codec="mp3",
        headerDurationMs=9000,  # an estimate from bitrate and size
        source={"gaplessInfo": "none"},
    )
    assert expected_canonical_ms(p, None) is None
    assert expected_canonical_ms(probe(headerDurationMs=2000), None) == 2000.0


def test_expected_duration_subtracts_end_padding_and_leading_offset() -> None:
    p = probe(
        headerDurationMs=2500,
        source={
            "timeBase": "1/1000",
            "startTimeTicks": 500,
            "startTimeMs": 500.0,
            "paddingSamples": 441,
        },
    )
    scan = clean_scan(first_pts=500, last_end=2510)
    # scan: (2510 - 500) ms minus 441 samples (10 ms) = 2000; header: 2500 - 500 = 2000
    assert expected_canonical_ms(p, scan) == pytest.approx(2000.0)
