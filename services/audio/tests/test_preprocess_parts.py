"""Small parts of the preprocess task: loudness parsing, WAV writing, verified reads, wiring."""

from __future__ import annotations

import errno
import hashlib
import io
import wave
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from helpers import CONFIG_HASH, REC, WS
from preprocess_fakes import SUMMARY

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.loudness import LOUDNESS_FILTER, loudness_argv, parse_summary
from audio_service.domain.storage import LocalStorageBackend, storage_failure
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.wav import HEADER_BYTES, WavWriter, wav_header

REFS = TaskRefs(UUID(WS), UUID(REC))
PREFIX = f"derived/{WS}/{REC}/{CONFIG_HASH}"
NAMES = frozenset({"a.bin", "result.json"})


# -- loudness ------------------------------------------------------------------------------------


def test_the_ebur128_summary_is_parsed_into_three_measured_quantities() -> None:
    quantities, missing = parse_summary(SUMMARY)
    assert missing == []
    assert quantities["integratedLoudnessLufs"].value == -20.5
    assert quantities["integratedLoudnessLufs"].unit == "LUFS"
    assert quantities["loudnessRangeLu"].value == 1.5
    assert quantities["truePeakDbtp"].value == -3.0
    assert {q.kind for q in quantities.values()} == {"measured"}


def test_dbtp_label_variant_and_noise_before_the_summary_are_accepted() -> None:
    noisy = b"Input #0 ... I: 99 LUFS in a tag\n" + SUMMARY.replace(b"dBFS", b"dBTP")
    quantities, missing = parse_summary(noisy)
    assert missing == [] and quantities["integratedLoudnessLufs"].value == -20.5


@pytest.mark.parametrize(
    ("blob", "reason"),
    [
        (b"", "summary_not_found"),
        (b"no summary at all\n", "summary_not_found"),
        (b"Summary:\n  I:  -inf LUFS\n  LRA:  nan LU\n  Peak:  -inf dBFS\n", "parse_failed"),
        (b"Summary:\n  Integrated loudness:\n", "parse_failed"),
    ],
)
def test_an_unparsable_summary_is_unavailable_with_a_reason_never_guessed(
    blob: bytes, reason: str
) -> None:
    quantities, missing = parse_summary(blob)
    assert quantities == {}
    assert {m.reason for m in missing} == {reason}
    assert [m.name for m in missing] == [
        "integratedLoudnessLufs",
        "loudnessRangeLu",
        "truePeakDbtp",
    ]


def test_the_loudness_command_reads_by_descriptor_and_writes_to_the_null_muxer() -> None:
    argv = loudness_argv(7, "wav")
    assert argv[argv.index("-loglevel") + 1] == "info"
    assert argv[argv.index("-af") + 1] == LOUDNESS_FILTER == "ebur128=peak=true:framelog=quiet"
    assert argv[-3:] == ["-f", "null", "-"]
    assert "-fd" in argv and argv[argv.index("-fd") + 1] == "7"
    assert "lavfi" not in argv and "-filter_complex" not in argv


# -- WAV -----------------------------------------------------------------------------------------


def test_wav_header_is_a_valid_riff_wave_header() -> None:
    header = wav_header(32_000)
    assert len(header) == HEADER_BYTES
    wav = wave.open(io.BytesIO(header + bytes(32_000)))
    assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (
        1,
        2,
        16000,
        16000,
    )


def test_wav_writer_patches_sizes_and_enforces_the_byte_budget() -> None:
    buffer = io.BytesIO()
    writer = WavWriter(buffer, budget_bytes=HEADER_BYTES + 100)
    writer.write(bytes(60))
    writer.write(bytes(40))
    with pytest.raises(TaskFailure) as raised:
        writer.write(b"\0\0")
    assert raised.value.code is ErrorCode.RESOURCE_LIMIT_EXCEEDED
    writer.finalize()
    assert len(buffer.getvalue()) == HEADER_BYTES + 100
    assert wave.open(io.BytesIO(buffer.getvalue())).getnframes() == 50


def test_wav_header_refuses_sizes_outside_riff() -> None:
    with pytest.raises(ValueError):  # noqa: PT011
        wav_header(0xFFFFFFFF)


# -- storage: digest and verified reads ----------------------------------------------------------


@pytest.fixture
def backend(tmp_path: Path) -> LocalStorageBackend:
    (tmp_path / "storage").mkdir()
    return LocalStorageBackend(tmp_path / "storage")


def publish(backend: LocalStorageBackend, files: dict[str, bytes]) -> None:
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        for name, data in files.items():
            session.create_file(name).write(data)
        session.publish()


def test_session_digest_matches_the_file_and_flushes_pending_writes(
    backend: LocalStorageBackend,
) -> None:
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        handle = session.create_file("a.bin")
        handle.write(b"hello")  # still buffered
        assert session.digest("a.bin") == (hashlib.sha256(b"hello").hexdigest(), 5)
        handle.write(b" world")
        assert session.digest("a.bin") == (hashlib.sha256(b"hello world").hexdigest(), 11)
        with pytest.raises(TaskFailure):
            session.digest("never-created")


def test_read_verified_returns_the_named_file_of_a_complete_output(
    backend: LocalStorageBackend,
) -> None:
    publish(backend, {"a.bin": b"abc", "result.json": b"{}"})
    got = backend.read_verified(PREFIX, REFS, "result.json", expected_names=NAMES, max_bytes=100)
    assert got == b"{}"


@pytest.mark.parametrize("damage", ["flip", "truncate", "no_manifest", "manifest_garbage"])
def test_read_verified_is_none_for_any_damaged_output(
    backend: LocalStorageBackend, tmp_path: Path, damage: str
) -> None:
    publish(backend, {"a.bin": b"abcdef", "result.json": b"{}"})
    out = tmp_path / "storage" / PREFIX
    if damage == "flip":
        (out / "a.bin").write_bytes(b"abcdeX")
    elif damage == "truncate":
        (out / "a.bin").write_bytes(b"abc")
    elif damage == "no_manifest":
        (out / "manifest.json").unlink()
    else:
        (out / "manifest.json").write_bytes(b"not json")
    assert (
        backend.read_verified(PREFIX, REFS, "result.json", expected_names=NAMES, max_bytes=100)
        is None
    )


def test_read_verified_checks_the_exact_file_set_size_limit_and_missing_prefix(
    backend: LocalStorageBackend,
) -> None:
    assert (
        backend.read_verified(PREFIX, REFS, "result.json", expected_names=NAMES, max_bytes=9)
        is None
    )  # nothing published
    publish(backend, {"a.bin": b"abc", "result.json": b"{}"})
    read = backend.read_verified
    assert read(PREFIX, REFS, "result.json", expected_names=NAMES | {"x"}, max_bytes=9) is None
    assert (
        read(PREFIX, REFS, "result.json", expected_names=frozenset({"a.bin"}), max_bytes=9) is None
    )
    assert read(PREFIX, REFS, "a.bin", expected_names=NAMES, max_bytes=2) is None  # too large
    assert read(PREFIX, REFS, "other.bin", expected_names=NAMES, max_bytes=9) is None


def test_read_verified_rejects_a_symlinked_file(
    backend: LocalStorageBackend, tmp_path: Path
) -> None:
    publish(backend, {"a.bin": b"abc", "result.json": b"{}"})
    out = tmp_path / "storage" / PREFIX
    (out / "result.json").unlink()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_bytes(b"{}")
    (out / "result.json").symlink_to(elsewhere)
    assert (
        backend.read_verified(PREFIX, REFS, "result.json", expected_names=NAMES, max_bytes=9)
        is None
    )


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (errno.ENOSPC, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        (errno.EIO, ErrorCode.STORAGE_ERROR),
    ],
)
def test_storage_failure_maps_os_errors_without_paths(error: int, code: ErrorCode) -> None:
    failure = storage_failure(OSError(error, "boom", "/secret/path"))
    assert failure.code is code and "/secret" not in str(failure)
