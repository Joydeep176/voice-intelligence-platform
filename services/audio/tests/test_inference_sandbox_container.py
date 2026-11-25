"""The inference sandbox profile under real Landlock (ADR-0036 / ADR-0037). Container only: the
engines and Landlock exist only in the audio image."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

from audio_service.domain.isolation import inference_runner, models_readable
from audio_service.domain.runner import Outcome, SandboxRunner

pytestmark = pytest.mark.container

PROBE = (
    "import sys\n"
    "import numpy, sherpa_onnx, pywhispercpp.model\n"
    "import audio_service.domain.inference_child\n"
    "def readable(p):\n"
    " try:\n"
    "  open(p, 'rb').read(1)\n"
    "  return True\n"
    " except PermissionError:\n"
    "  return False\n"
    "print(readable(sys.argv[1]), readable(sys.argv[2]))\n"
)


@pytest.fixture
def dirs(tmp_path: Path) -> tuple[Path, Path]:
    models = tmp_path / "models"
    storage = tmp_path / "storage"
    models.mkdir()
    storage.mkdir()
    (models / "model.bin").write_bytes(b"m")
    (storage / "canonical.wav").write_bytes(b"s")
    return models, storage


@pytest.fixture
def runner(dirs: tuple[Path, Path]) -> Iterator[SandboxRunner]:
    r = inference_runner("required", dirs[0])
    yield r
    r.close()


def test_the_inference_profile_is_verified_enforced(runner: SandboxRunner) -> None:
    assert runner.verify_enforcement() is True
    assert runner.landlock_enforced


def test_engines_load_and_only_models_are_readable(
    runner: SandboxRunner, dirs: tuple[Path, Path]
) -> None:
    """Imports the native engines under Landlock and the rlimits (NOFILE, FSIZE=0): models are
    readable, storage is not (the WAV arrives only as an inherited descriptor)."""
    assert runner.verify_enforcement()
    models, storage = dirs
    out = bytearray()
    result = runner.run(
        [sys.executable, "-c", PROBE, str(models / "model.bin"), str(storage / "canonical.wav")],
        stdout_sink=out.extend,
        timeout_s=60,
    )
    assert (result.outcome, result.returncode) == (Outcome.EXITED, 0), result.stderr[-2000:]
    assert out.strip() == b"True False"


def test_the_models_self_test_passes_on_a_native_filesystem(
    runner: SandboxRunner, dirs: tuple[Path, Path]
) -> None:
    """tmpfs, like an ext4 volume, keeps inodes stable, so the Landlock rule matches (on Docker
    Desktop host bind mounts it does not, and the service reports not-ready)."""
    assert runner.verify_enforcement()
    assert models_readable(runner, dirs[0], ["model.bin"]) is True
    assert models_readable(runner, dirs[1].parent, ["storage/canonical.wav"]) is False
