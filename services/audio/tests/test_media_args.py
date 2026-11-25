from __future__ import annotations

from audio_service.domain.ffmpeg_args import ffprobe_command
from audio_service.domain.media_args import (
    CODEC_WHITELIST,
    FORMAT_WHITELIST,
    classify_stderr,
    input_options,
    refusal_code_hint,
)
from audio_service.domain.runner import STDERR_CAP_BYTES

CAP = STDERR_CAP_BYTES


def test_codec_whitelist_names_decoders_not_just_codecs() -> None:
    names = CODEC_WHITELIST.split(",")
    # FFmpeg matches decoder names: `mp3` alone does not admit the `mp3float` decoder (measured).
    assert {"mp3", "mp3float", "aac", "alac", "flac", "vorbis", "opus", "libopus"} <= set(names)
    assert {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"} <= set(names)
    assert {"pcm_s16be", "pcm_s24be", "pcm_s32be", "pcm_f32be"} <= set(names)
    assert not {"h264", "mpeg4", "hevc", "vp9", "av1", "ass", "subrip"} & set(names)
    assert {"mjpeg", "png"} <= set(names)  # attached cover art only; never decoded (-vn)


def test_format_whitelist_is_the_plan_list_and_has_no_playlist_demuxers() -> None:
    assert FORMAT_WHITELIST == "wav,mp3,mov,mp4,m4a,3gp,3g2,mj2,flac,ogg,matroska,webm"
    assert not {"hls", "dash", "concat", "image2", "ffconcat", "lavfi"} & set(
        FORMAT_WHITELIST.split(",")
    )


def test_input_options_force_the_demuxer_and_bound_probing() -> None:
    options = input_options("wav")
    assert options[:2] == ["-f", "wav"]
    assert options[options.index("-codec_whitelist") + 1] == CODEC_WHITELIST
    assert options[options.index("-format_whitelist") + 1] == FORMAT_WHITELIST
    assert options[options.index("-probesize") + 1] == "5000000"
    assert options[options.index("-analyzeduration") + 1] == "10000000"
    assert "-enable_drefs" not in options


def test_mov_options_are_added_only_for_mov() -> None:
    options = input_options("mov")
    assert options[options.index("-enable_drefs") + 1] == "0"
    assert options[options.index("-use_absolute_path") + 1] == "0"
    assert all("-enable_drefs" not in input_options(d) for d in ("wav", "mp3", "flac", "ogg"))


def test_the_assembled_command_is_accepted_by_the_argument_guard() -> None:
    argv = ffprobe_command(5, input_options=input_options("mov"))
    assert argv[argv.index("-protocol_whitelist") + 1] == "fd,pipe"
    assert argv[-2:] == ["-i", "fd:"]


def test_stderr_classification_counts_classes_and_keeps_no_text() -> None:
    stderr = (
        b"[mp3float @ 0x1] Header missing\n"
        b"    Last message repeated 4 times\n"
        b"[mpeg4 @ 0x2] Codec (mpeg4) not on whitelist 'x'\n"
        b"[Parsed_aresample_0 @ 0x3] [SWR @ 0x4] Failed to compensate for timestamp delta of 9.5\n"
        b"\n"
        b"[aac @ 0x5] channel element 1.0 is not allocated\n"
    )
    classes = classify_stderr(stderr, cap=CAP)
    assert (classes.decode_errors, classes.whitelist_refusals, classes.compensation_failures) == (
        6,
        1,
        1,
    )
    assert classes.total == 8 and not classes.truncated
    assert not hasattr(classes, "text") and "Header" not in repr(classes)


def test_repeat_lines_attach_to_the_previous_class() -> None:
    classes = classify_stderr(b"x not on whitelist\n    Last message repeated 2 times\n", cap=CAP)
    assert (classes.whitelist_refusals, classes.decode_errors) == (3, 0)


def test_a_full_buffer_marks_counts_as_lower_bounds() -> None:
    assert classify_stderr(b"x\n" * (CAP // 2), cap=CAP).truncated
    assert not classify_stderr(b"x\n", cap=CAP).truncated


def test_refusal_hint() -> None:
    assert refusal_code_hint(b"Codec (h264) not on whitelist 'x'") == "whitelist"
    assert refusal_code_hint(b"Invalid data found") == "other"
