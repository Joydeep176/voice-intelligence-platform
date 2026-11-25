"""Probe logic against a scripted runner: limits, failure mapping, tag removal (no FFmpeg)."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

import pytest
from media_fakes import FakeRunner, Script, probe_json, result, tmp_file

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.media_limits import MediaLimits
from audio_service.domain.probe import classify_gapless, probe_media
from audio_service.domain.runner import STDERR_CAP_BYTES, Outcome, RunResult, SandboxRunner

LIMITS = MediaLimits(max_duration_ms=14_400_000, max_channels=8, max_sample_rate_hz=192_000)
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 8
EDGE_CSV = (
    b"0,0,368640,K__,Skip Samples,1105,0,0,0\n"
    b"368640,368640,368640,K__\n"
    b"42393600,42393600,368640,K__,Skip Samples,0,227,0,0\n"
)


def ffprobe_script(
    document: dict[str, Any], *, edges: bytes = EDGE_CSV, rc: int = 0, stderr: bytes = b""
) -> Script:
    def script(argv: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        if "-read_intervals" in argv:
            sink(edges)
            return result()
        sink(json.dumps(document).encode())
        return result(rc=rc, stderr=stderr)

    return script


def ffmpeg_script(nbytes: int = 32000, stderr: bytes = b"") -> Script:
    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        if nbytes:
            sink(b"\0" * nbytes)
        return result(stderr=stderr)

    return script


def run_probe(runner: FakeRunner, content: bytes = MP3, limits: MediaLimits = LIMITS) -> Any:
    fd = tmp_file(content)
    try:
        return probe_media(runner, fd, limits)  # type: ignore[arg-type]
    finally:
        os.close(fd)


def runner_for(document: dict[str, Any] | None = None, **kwargs: Any) -> FakeRunner:
    return FakeRunner(
        {
            "ffprobe": ffprobe_script(document or probe_json(), **kwargs.pop("probe", {})),
            "ffmpeg": ffmpeg_script(**kwargs.pop("decode", {})),
        }
    )


def code_of(runner: FakeRunner, **kwargs: Any) -> ErrorCode:
    with pytest.raises(TaskFailure) as info:
        run_probe(runner, **kwargs)
    return info.value.code


def test_result_for_an_mp3_with_lame_info() -> None:
    probe = run_probe(runner_for())
    assert (probe.container, probe.demuxer, probe.codec) == ("mp3", "mp3", "mp3")
    assert (probe.sampleRateHz, probe.channels, probe.headerDurationMs) == (44100, 2, 2038)
    assert (probe.streamCount, probe.audioStreamCount) == (1, 1)
    assert probe.timelineSource.gaplessInfo == "lame"
    assert probe.timelineSource.encoderDelaySamples == 1105
    assert probe.timelineSource.paddingSamples == 227
    assert probe.timelineSource.editListPresent is False
    assert probe.trialDecode.model_dump() == {"decodable": True, "decodedMs": 2000}
    assert probe.tools.ffprobe == "7.1.5-test"


def test_container_tags_are_never_returned() -> None:
    document = probe_json()
    document["format"]["tags"] = {"title": "PRIVATE-TITLE", "artist": "PRIVATE-ARTIST"}
    document["streams"][0]["tags"] = {"comment": "PRIVATE-COMMENT"}
    probe = run_probe(runner_for(document))
    assert "PRIVATE" not in probe.model_dump_json()
    assert "tags" not in probe.model_dump_json()


def test_ffprobe_is_asked_for_explicit_fields_never_for_tags() -> None:
    runner = runner_for()
    run_probe(runner)
    first = runner.calls[0]
    entries = first[first.index("-show_entries") + 1]
    assert "tags" not in entries.replace("format_tags=iTunSMPB", "")  # only the gapless marker
    assert "-show_format" not in first and "-show_streams" not in first
    assert "iTunSMPB" not in entries  # not requested for MP3: that is a MOV-only marker
    assert first[first.index("-f") + 1] == "mp3"
    assert "-enable_drefs" not in first  # mov-only options are not applied to other demuxers


def test_mov_options_apply_only_to_the_mov_demuxer() -> None:
    mp4 = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A mp42isom"
    document = probe_json(stream={"codec_name": "aac", "time_base": "1/44100", "start_pts": 0})
    document["format"]["format_name"] = "mov,mp4,m4a,3gp,3g2,mj2"
    runner = runner_for(document)
    probe = run_probe(runner, mp4)
    first = runner.calls[0]
    assert first[first.index("-enable_drefs") + 1] == "0"
    assert first[first.index("-use_absolute_path") + 1] == "0"
    assert "iTunSMPB" in first[first.index("-show_entries") + 1]
    assert probe.container == "mp4" and probe.demuxer == "mov"


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        (b"", ErrorCode.CORRUPT_MEDIA),
        (b"RIFF", ErrorCode.CORRUPT_MEDIA),
        (b"#EXTM3U\n#EXT-X-VERSION:3\nseg.ts\n", ErrorCode.UNSUPPORTED_FORMAT),
        (b"ffconcat version 1.0\nfile /etc/passwd\n", ErrorCode.UNSUPPORTED_FORMAT),
        (b"<?xml version='1.0'?><MPD></MPD>", ErrorCode.UNSUPPORTED_FORMAT),
    ],
)
def test_content_that_is_not_a_known_container_never_reaches_ffprobe(
    content: bytes, expected: ErrorCode
) -> None:
    runner = runner_for()
    assert code_of(runner, content=content) is expected
    assert runner.calls == []


def test_a_video_only_file_has_no_decodable_audio() -> None:
    document = probe_json()
    document["streams"][0].update(codec_type="video", codec_name="mjpeg")
    assert code_of(runner_for(document)) is ErrorCode.NO_DECODABLE_AUDIO


@pytest.mark.parametrize("missing", ["sample_rate", "channels", "codec_name", "sample_fmt"])
def test_an_audio_stream_without_core_parameters_is_not_decodable(missing: str) -> None:
    document = probe_json()
    del document["streams"][0][missing]
    assert code_of(runner_for(document)) is ErrorCode.NO_DECODABLE_AUDIO


@pytest.mark.parametrize(
    ("override", "limits", "expected"),
    [
        ({"channels": 9}, LIMITS, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        ({"channels": 255}, LIMITS, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        ({"sample_rate": "768000"}, LIMITS, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        ({"channels": 3}, MediaLimits(14_400_000, 2, 192_000), ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        ({"duration": "14400.001"}, LIMITS, ErrorCode.DURATION_LIMIT_EXCEEDED),
        ({"duration": "100000000"}, LIMITS, ErrorCode.DURATION_LIMIT_EXCEEDED),
        ({"duration": "61"}, MediaLimits(60_000, 8, 192_000), ErrorCode.DURATION_LIMIT_EXCEEDED),
    ],
)
def test_limits_reject_and_never_truncate(
    override: dict[str, Any], limits: MediaLimits, expected: ErrorCode
) -> None:
    runner = runner_for(probe_json(stream=override))
    assert code_of(runner, limits=limits) is expected
    assert not any("ffmpeg" == c[0] for c in runner.calls)  # rejected before any decoding


def test_the_limits_themselves_are_inclusive() -> None:
    document = probe_json(stream={"channels": 8, "sample_rate": "192000", "duration": "14400"})
    assert run_probe(runner_for(document)).channels == 8


def test_header_duration_unknown_is_a_warning_not_a_failure() -> None:
    document = probe_json()
    del document["streams"][0]["duration"]
    probe = run_probe(runner_for(document))
    assert probe.headerDurationMs is None
    assert "header_duration_unknown" in probe.warnings


def test_extra_streams_are_reported_and_the_first_audio_stream_is_used() -> None:
    document = probe_json()
    document["streams"].insert(0, {"index": 0, "codec_type": "video", "codec_name": "mjpeg"})
    document["streams"].append(dict(document["streams"][1], index=2, sample_rate="8000"))
    probe = run_probe(runner_for(document))
    assert probe.sampleRateHz == 44100
    assert (probe.streamCount, probe.audioStreamCount) == (3, 2)
    assert {"multiple_audio_streams", "non_audio_streams_ignored"} <= set(probe.warnings)


@pytest.mark.parametrize(
    ("stderr", "rc", "expected"),
    [
        (b"[mpeg4 @ 0x1] Codec (mpeg4) not on whitelist 'x'\n", 1, ErrorCode.UNSUPPORTED_FORMAT),
        (b"Invalid data found when processing input\n", 183, ErrorCode.CORRUPT_MEDIA),
        # A child killed by a signal is a host condition, never a property of the file (it used to
        # map to CORRUPT_MEDIA, which Node persists as a permanent invalidity).
        (b"", -11, ErrorCode.RESOURCE_EXHAUSTED),  # SIGSEGV
    ],
)
def test_a_failing_ffprobe_maps_to_a_code(stderr: bytes, rc: int, expected: ErrorCode) -> None:
    runner = runner_for(probe={"rc": rc, "stderr": stderr})
    assert code_of(runner) is expected


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (Outcome.TIMEOUT, ErrorCode.TIMEOUT),
        (Outcome.OUTPUT_LIMIT, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        (Outcome.CANCELLED, ErrorCode.CANCELLED),
    ],
)
def test_non_normal_outcomes_map_to_codes(outcome: Outcome, expected: ErrorCode) -> None:
    def script(_a: list[str], _s: Any, _x: Any) -> RunResult:
        return result(outcome, None)

    assert code_of(FakeRunner({"ffprobe": script})) is expected


def test_invalid_json_is_corrupt_media() -> None:
    def script(_a: list[str], sink: Callable[[bytes], None], _x: Any) -> RunResult:
        sink(b"{not json")
        return result()

    assert code_of(FakeRunner({"ffprobe": script})) is ErrorCode.CORRUPT_MEDIA


def test_trial_decode_with_no_output_and_no_errors_means_the_file_ends_after_its_header() -> None:
    assert code_of(runner_for(decode={"nbytes": 0})) is ErrorCode.CORRUPT_MEDIA


def test_trial_decode_with_no_output_and_decoder_errors_is_no_decodable_audio() -> None:
    runner = runner_for(decode={"nbytes": 0, "stderr": b"[mp3float @ 0x1] Header missing\n"})
    assert code_of(runner) is ErrorCode.NO_DECODABLE_AUDIO


def test_trial_decode_refused_by_the_codec_whitelist_is_unsupported() -> None:
    runner = runner_for(decode={"nbytes": 0, "stderr": b"[x @ 0x1] Codec (y) not on whitelist\n"})
    assert code_of(runner) is ErrorCode.UNSUPPORTED_FORMAT


def test_trial_decode_with_some_output_and_errors_is_decodable_with_a_warning() -> None:
    runner = runner_for(decode={"nbytes": 16000, "stderr": b"[mp3float @ 0x1] bad frame\n"})
    probe = run_probe(runner)
    assert probe.trialDecode.decodedMs == 1000
    assert "trial_decode_errors" in probe.warnings


def test_trial_decode_is_bounded_to_thirty_seconds_and_stays_inside_the_sandbox_options() -> None:
    runner = runner_for()
    run_probe(runner)
    decode = next(c for c in runner.calls if c[0] == "ffmpeg")
    assert decode[decode.index("-t") + 1] == "30"
    assert "-vn" in decode and "-sn" in decode and "-dn" in decode
    assert decode[decode.index("-protocol_whitelist") + 1] == "fd,pipe"
    assert decode[decode.index("-max_alloc") + 1] == "268435456"
    assert decode[decode.index("-probesize") + 1] == "5000000"


def test_edge_packet_failure_is_a_warning_and_leaves_gapless_unknown_fields_empty() -> None:
    runner = runner_for(probe={"edges": b"garbage-without-commas\n"})
    probe = run_probe(runner)
    assert "edge_packets_unavailable" in probe.warnings
    assert probe.timelineSource.encoderDelaySamples is None
    assert probe.timelineSource.gaplessInfo == "none"


def test_stderr_text_is_not_in_the_result_or_the_error() -> None:
    secret = b"PRIVATE-FILE-TITLE"
    runner = runner_for(probe={"rc": 1, "stderr": secret})
    with pytest.raises(TaskFailure) as info:
        run_probe(runner)
    assert "PRIVATE" not in str(info.value) and "PRIVATE" not in repr(info.value)


def test_stderr_cap_is_the_runner_constant() -> None:
    assert STDERR_CAP_BYTES == 64 * 1024
    assert SandboxRunner  # imported for the constant above


@pytest.mark.parametrize(
    ("container", "codec", "kwargs", "expected"),
    [
        ("mp3", "mp3", {"skip_samples": 1105}, ("lame", False)),
        ("mp3", "mp3", {"skip_samples": None}, ("none", False)),
        ("mp4", "aac", {"skip_samples": 1024}, ("edit_list", True)),
        ("mp4", "aac", {"skip_samples": None, "first_pts": -1024}, ("edit_list", True)),
        ("mp4", "aac", {"skip_samples": None, "start_ms": 476.0}, ("edit_list", True)),
        ("mp4", "aac", {"itunsmpb": True}, ("itunsmpb", True)),
        ("mp4", "aac", {"skip_samples": None}, ("unknown", "unknown")),
        ("ogg", "opus", {"skip_samples": 312}, ("codec_preskip", False)),
        ("matroska", "opus", {"skip_samples": None}, ("none", False)),
        ("ogg", "vorbis", {"skip_samples": None}, ("none", False)),
        ("wav", "pcm_s16le", {"skip_samples": None}, ("none", False)),
        ("flac", "flac", {"skip_samples": None}, ("none", False)),
    ],
)
def test_gapless_classification(
    container: str, codec: str, kwargs: dict[str, Any], expected: tuple[str, Any]
) -> None:
    base: dict[str, Any] = {
        "skip_samples": None,
        "first_pts": None,
        "start_ms": None,
        "itunsmpb": False,
    }
    base.update(kwargs)
    assert classify_gapless(container, codec, **base) == expected
