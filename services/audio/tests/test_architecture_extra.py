"""Boundaries added in Phase 2B WS1."""

from __future__ import annotations

import ast

from test_architecture import PACKAGE, imported_roots

SUBPROCESS_USERS = {"runner.py", "capabilities.py"}


def test_only_the_runner_and_capability_probe_spawn_processes() -> None:
    offenders = [
        str(p.relative_to(PACKAGE))
        for p in PACKAGE.rglob("*.py")
        if "subprocess" in imported_roots(p) and p.name not in SUBPROCESS_USERS
    ]
    assert offenders == []


def test_domain_modules_exist_and_stay_framework_free() -> None:
    domain = PACKAGE / "domain"
    modules = {
        "tasks.py",
        "storage.py",
        "storage_keys.py",
        "runner.py",
        "landlock.py",
        "capabilities.py",
        "ffmpeg_args.py",
        "errors.py",
        "probe.py",
        "decoder.py",
        "timeline.py",
        "packets.py",
        "media_args.py",
        "media_io.py",
        "media_limits.py",
        "media_sniff.py",
        "preprocess.py",
        "measurements.py",
        "loudness.py",
        "wav.py",
        "vad.py",
        "segmentation.py",
    }
    assert modules <= {p.name for p in domain.glob("*.py")}
    for name in modules:
        assert not imported_roots(domain / name) & {"fastapi", "starlette", "uvicorn"}, name


DETECTOR_LIBRARIES = {"torch", "onnxruntime", "webrtcvad", "silero_vad", "tensorflow", "pyannote"}


def test_vad_is_used_only_by_transcription_through_sherpa_onnx() -> None:
    """OD-29 resolved (ADR-0038): Silero VAD runs only inside the `transcribe` task, through
    sherpa-onnx. No other detector library is imported in src, `vad.py` stays an interface, and
    preprocessing still registers no detector (method `none`, next test)."""
    for p in PACKAGE.rglob("*.py"):
        assert not imported_roots(p) & DETECTOR_LIBRARIES, p
    tree = ast.parse((PACKAGE / "domain" / "vad.py").read_text())
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    assert [c.name for c in classes] == ["VoiceActivityDetector"]
    assert not [n for n in tree.body if isinstance(n, ast.FunctionDef)]
    implementers = [
        str(p.relative_to(PACKAGE))
        for p in PACKAGE.rglob("*.py")
        if "VoiceActivityDetector" in p.read_text()
        and p.name not in {"vad.py", "preprocess.py", "segmentation.py"}
    ]
    assert implementers == ["domain/transcribe.py"]


def test_the_handler_registers_no_detector_by_default() -> None:
    from audio_service.domain.preprocess import PreprocessHandler

    handler = PreprocessHandler(
        lambda: None, lambda: None, lambda: None,  # type: ignore[arg-type, return-value]
        max_duration_ms=1, max_channels=1, max_sample_rate_hz=1,
    )  # fmt: skip
    assert dict(handler._detectors) == {}  # noqa: SLF001


def test_segmentation_has_no_framework_or_io_imports() -> None:
    forbidden = {"fastapi", "starlette", "uvicorn", "subprocess", "socket", "requests", "httpx"}
    for name in ("segmentation.py", "vad.py"):
        assert not imported_roots(PACKAGE / "domain" / name) & forbidden, name
