"""The `preprocess` task against real FFmpeg in the audio image (analytic signals, real decodes)."""

from __future__ import annotations

import hashlib
import json
import os
import resource
import shutil
import threading
import time
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import test_segmentation_fakes as fakes
import timestamp_lab as lab
from fastapi.testclient import TestClient
from helpers import REC, WS, task_body, wait_for
from preprocess_fakes import make_config, make_context, prefix_for

from audio_service.api.app import create_app
from audio_service.config import Settings
from audio_service.contracts import ErrorCode, PreprocessResult, TaskProgress
from audio_service.domain.capabilities import measure_capabilities
from audio_service.domain.errors import TaskCancelled
from audio_service.domain.preprocess import PreprocessHandler, ToolVersions
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.tasks import CancellationToken

pytestmark = pytest.mark.container

LONG_DIR = os.environ.get("AUDIO_SERVICE_TEST_LONG_DIR")


@pytest.fixture(scope="module")
def runner() -> Iterator[SandboxRunner]:
    r = SandboxRunner("auto")
    r.verify_enforcement()
    yield r
    r.close()


@pytest.fixture(scope="module")
def versions(runner: SandboxRunner) -> ToolVersions:
    caps = measure_capabilities(runner, [])
    assert caps.ffmpeg is not None
    return ToolVersions(caps.serviceVersion, caps.python, caps.ffmpeg.version, caps.numpy)


def config_for(versions: ToolVersions, **changes: Any) -> dict[str, Any]:
    return make_config(toolVersions=versions.as_dict(), **changes)


def handler(root: Path, runner: Any, versions: ToolVersions) -> PreprocessHandler:
    storage = LocalStorageBackend(root)
    return PreprocessHandler(
        lambda: storage,
        lambda: runner,
        lambda: versions,
        max_duration_ms=14_400_000,
        max_channels=8,
        max_sample_rate_hz=192_000,
    )


def place(root: Path, source: Path) -> None:
    dest = root / "recordings" / WS / REC / "original"
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, dest)


def preprocess(
    runner: Any,
    versions: ToolVersions,
    root: Path,
    source: Path,
    config: dict[str, Any] | None = None,
    **kw: Any,
) -> dict[str, Any]:
    place(root, source)
    ctx = make_context(
        config or config_for(versions),
        cancel=kw.pop("cancel", None),
        progress=kw.pop("progress", None),
    )
    return handler(root, runner, versions)(ctx)


def write_pcm(path: Path, pcm: np.ndarray[Any, Any], rate: int, width: int = 2) -> None:
    """A PCM WAV with exactly these codes. `pcm` is (frames,) or (frames, channels) integers."""
    frames = pcm.reshape(pcm.shape[0], -1)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(frames.shape[1])
        wav.setsampwidth(width)
        wav.setframerate(rate)
        if width == 2:
            wav.writeframes(frames.astype("<i2").tobytes())
        else:  # 24-bit: the low three bytes of each little-endian 32-bit code
            raw = frames.astype("<i4").tobytes()
            wav.writeframes(b"".join(raw[i : i + 3] for i in range(0, len(raw), 4)))


def write_float_wav(path: Path, signal: np.ndarray[Any, Any], rate: int) -> None:
    frames = signal.astype("<f4").reshape(signal.shape[0], -1)
    raw = path.with_suffix(".f32")
    raw.write_bytes(frames.tobytes())
    lab.ffmpeg(
        ["-f", "f32le", "-ar", str(rate), "-ac", str(frames.shape[1]), "-i", str(raw),
         "-c:a", "pcm_f32le", str(path)]
    )  # fmt: skip
    raw.unlink()


def sine(rate: int, seconds: float = 1.0, amplitude: float = 1.0, hz: int = 1000) -> Any:
    return amplitude * np.sin(2 * np.pi * hz * np.arange(int(rate * seconds)) / rate)


def q(result: dict[str, Any], record: int, name: str, channel: int | None = None) -> float:
    rec = result["measurements"][record]
    quantities = rec["quantities"] if channel is None else rec["perChannel"][channel]["quantities"]
    return float(quantities[name]["value"])


def children() -> list[str]:
    found = []
    for entry in Path("/proc").iterdir():
        if entry.name.isdigit():
            try:
                comm = (entry / "comm").read_text().strip()
            except OSError:
                continue
            if comm in ("ffmpeg", "ffprobe"):
                found.append(entry.name)
    return found


def temp_dirs(root: Path) -> list[Path]:
    return list(root.rglob(".tmp-*"))


@pytest.fixture
def root(tmp_path: Path) -> Iterator[Path]:
    yield tmp_path / "storage"
    shutil.rmtree(tmp_path, ignore_errors=True)  # the container's tmpfs is only 16 MB


# -- accuracy on analytic signals through the real decode ------------------------------------------


def test_full_scale_float_sine_is_measured_exactly(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    path = tmp_path / "a.wav"
    write_float_wav(path, sine(48000), 48000)
    config = config_for(versions, measurement__clipping__minRunSamples=1)
    result = preprocess(runner, versions, root, path, config)
    PreprocessResult.model_validate(result)
    assert q(result, 0, "peakDbfs") == pytest.approx(0.0, abs=0.01)
    assert q(result, 0, "rmsDbfs") == pytest.approx(-3.0103, abs=0.01)
    assert q(result, 0, "crestFactorDb") == pytest.approx(3.0103, abs=0.01)
    assert q(result, 0, "clippedSamples") == 2000  # +1.0 and -1.0 once per cycle, 1000 cycles
    assert q(result, 0, "clippedRuns") == 2000 and q(result, 0, "longestClippedRunSamples") == 1
    # BS.1770 is calibrated so a 0 dBFS 1 kHz sine reads its mean-square level, -3.01 LUFS
    assert q(result, 0, "integratedLoudnessLufs") == pytest.approx(-3.01, abs=0.1)
    assert q(result, 0, "truePeakDbtp") == pytest.approx(0.0, abs=0.3)
    # the canonical (resampled) pass sees the same level
    assert q(result, 1, "rmsDbfs") == pytest.approx(-3.0103, abs=0.05)


def test_int16_square_wave_clipping_counts_are_exact(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    one = np.concatenate([np.full(10, 32767), np.full(10, -32768)])
    path = tmp_path / "sq.wav"
    write_pcm(path, np.tile(one, 400), 8000)
    result = preprocess(runner, versions, root, path)
    assert q(result, 0, "clippedSamples") == 8000
    assert q(result, 0, "clippedRatio") == 1.0
    assert q(result, 0, "clippedRuns") == 800  # a run at each rail per period
    assert q(result, 0, "longestClippedRunSamples") == 10
    assert q(result, 0, "peakDbfs") == pytest.approx(0.0, abs=0.001)


def test_known_clipped_runs_in_a_16_bit_source_and_near_full_scale_is_not_clipping(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    pcm = np.zeros(80_000, dtype=np.int32)
    pcm[1000:1003] = 32767  # a run of 3
    pcm[40_000:40_007] = -32768  # a run of 7, across the 10 s block boundary at 8 kHz? no: 5 s
    pcm[79_990:80_000] = 32767  # a run of 10 still open at the end of the file
    pcm[2000:2050] = 32766  # one code below full scale: not clipped
    path = tmp_path / "runs.wav"
    write_pcm(path, pcm, 8000)
    result = preprocess(runner, versions, root, path)
    assert q(result, 0, "clippedSamples") == 3 + 7 + 10
    assert q(result, 0, "clippedRuns") == 3
    assert q(result, 0, "longestClippedRunSamples") == 10


def test_24_bit_source_uses_the_24_bit_extreme_codes(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    pcm = np.zeros(4000, dtype=np.int32)
    pcm[100:104] = 8_388_607
    pcm[500:502] = -8_388_608
    pcm[900:905] = 8_388_606  # one code below
    path = tmp_path / "s24.wav"
    write_pcm(path, pcm, 16000, width=3)
    result = preprocess(runner, versions, root, path)
    assert q(result, 0, "clippedSamples") == 6
    assert q(result, 0, "longestClippedRunSamples") == 4


def test_dc_offset_and_digital_silence(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    dc = tmp_path / "dc.wav"
    write_pcm(dc, np.full(16000, 8192), 16000)
    result = preprocess(runner, versions, root, dc)
    assert q(result, 0, "dcOffset", 0) == pytest.approx(0.25, abs=1e-9)
    assert q(result, 0, "rmsDbfs") == pytest.approx(-12.0412, abs=0.001)

    silent = tmp_path / "zero.wav"
    write_pcm(silent, np.zeros(16000), 16000)
    other = preprocess(runner, versions, root.with_name("storage2"), silent)
    unavailable = {u["name"]: u["reason"] for u in other["measurements"][0]["unavailable"]}
    assert unavailable["peakDbfs"] == unavailable["rmsDbfs"] == "digital_silence"
    assert q(other, 1, "silenceRatio") == 1.0


def test_white_noise_statistics_with_a_fixed_seed(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    noise = np.random.default_rng(20261121).standard_normal(16000 * 3) * 3277  # sigma 0.1
    path = tmp_path / "noise.wav"
    write_pcm(path, np.clip(np.round(noise), -32768, 32767).astype(np.int32), 16000)
    result = preprocess(runner, versions, root, path)
    assert q(result, 0, "rmsDbfs") == pytest.approx(-20.0, abs=0.1)
    assert q(result, 1, "rmsDbfs") == pytest.approx(-20.0, abs=0.1)
    assert abs(q(result, 0, "dcOffset", 0)) < 1e-3
    assert q(result, 1, "noiseFloorDbfs") == pytest.approx(-20.0, abs=1.5)


@pytest.mark.parametrize(
    ("kind", "expected"), [("identical", 1.0), ("inverted", -1.0), ("independent", 0.0)]
)
def test_stereo_channel_correlation(  # noqa: PLR0913, PLR0917
    runner: SandboxRunner,
    versions: ToolVersions,
    root: Path,
    tmp_path: Path,
    kind: str,
    expected: float,
) -> None:
    rng = np.random.default_rng(5)
    left = np.round(rng.standard_normal(32000) * 3000).astype(np.int32)
    right = {"identical": left, "inverted": -left}.get(
        kind, np.round(rng.standard_normal(32000) * 3000).astype(np.int32)
    )
    path = tmp_path / "st.wav"
    write_pcm(path, np.stack([left, right], axis=1), 16000)
    result = preprocess(runner, versions, root, path)
    assert result["measurements"][0]["channels"] == 2
    assert len(result["measurements"][0]["perChannel"]) == 2
    assert q(result, 0, "correlationCh0Ch1") == pytest.approx(expected, abs=0.02)


@pytest.mark.parametrize(
    ("rate", "channels"),
    [(8000, 1), (16000, 1), (22050, 2), (44100, 2), (48000, 1), (96000, 2), (192000, 2)],
)
def test_sources_from_8_to_192_khz_mono_and_stereo(  # noqa: PLR0913, PLR0917
    runner: SandboxRunner,
    versions: ToolVersions,
    root: Path,
    tmp_path: Path,
    rate: int,
    channels: int,
) -> None:
    tone = np.round(sine(rate, 1.0, 0.5, 440) * 32767).astype(np.int32)
    path = tmp_path / "x.wav"
    write_pcm(path, np.stack([tone] * channels, axis=1) if channels > 1 else tone, rate)
    result = preprocess(runner, versions, root, path)
    parsed = PreprocessResult.model_validate(result)
    assert parsed.measurements[0].sampleRateHz == rate
    assert parsed.measurements[0].channels == channels
    assert parsed.timeline.nativeSampleRate == rate
    assert parsed.timeline.decodedSamplesNative == rate
    assert parsed.timeline.decodeClass == "full" and parsed.timeline.mappingStatus == "exact"
    assert parsed.canonical.samples == 16000 == parsed.timeline.canonicalSamples
    assert q(result, 0, "peakDbfs") == pytest.approx(-6.02, abs=0.01)
    assert q(result, 0, "rmsDbfs") == pytest.approx(-9.03, abs=0.01)
    assert q(result, 1, "rmsDbfs") == pytest.approx(-9.03, abs=0.1)


def test_canonical_wav_is_valid_and_its_length_is_the_decoded_sample_count(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    tone = np.round(sine(44100, 2.5, 0.5, 300) * 32767).astype(np.int32)
    path = tmp_path / "x.wav"
    write_pcm(path, tone, 44100)
    result = preprocess(runner, versions, root, path)
    canonical = root / prefix_for(config_for(versions)) / "canonical.wav"
    with wave.open(str(canonical)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
        assert wav.getnframes() == result["canonical"]["samples"] == 40_000
    assert result["canonical"]["durationMs"] == 40_000 / 16 == 2500.0
    assert result["canonical"]["bytes"] == canonical.stat().st_size == 44 + 80_000
    assert result["canonical"]["sha256"] == hashlib.sha256(canonical.read_bytes()).hexdigest()
    assert q(result, 1, "sampleCount") == 40_000
    assert temp_dirs(root) == []


# -- determinism, reuse, integrity ---------------------------------------------------------------


def test_the_same_input_twice_gives_identical_outputs(
    runner: SandboxRunner, versions: ToolVersions, tmp_path: Path
) -> None:
    results, manifests = [], []
    for name in ("one", "two"):
        path = tmp_path / f"{name}.wav"
        tone = np.round(sine(44100, 2.0, 0.4, 523) * 32767).astype(np.int32)
        write_pcm(path, np.stack([tone, tone // 2], axis=1), 44100)
        root = tmp_path / name
        results.append(json.dumps(preprocess(runner, versions, root, path), sort_keys=True))
        out = root / prefix_for(config_for(versions))
        manifests.append({p.name: p.read_bytes() for p in sorted(out.iterdir()) if p.is_file()})
    assert results[0] == results[1]
    assert manifests[0] == manifests[1]  # canonical.wav, level series, result.json, manifest.json


def test_a_published_output_is_reused_without_starting_ffmpeg(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    path = tmp_path / "a.wav"
    write_pcm(path, np.round(sine(16000, 1.0, 0.3) * 32767).astype(np.int32), 16000)
    first = preprocess(runner, versions, root, path)

    class Counting:
        calls = 0

        def run(self, *args: Any, **kwargs: Any) -> Any:
            Counting.calls += 1
            return runner.run(*args, **kwargs)

    again = handler(root, Counting(), versions)(make_context(config_for(versions)))
    assert again == first and Counting.calls == 0


def test_hash_and_tool_version_mismatches_are_rejected_before_any_decode(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    path = tmp_path / "a.wav"
    write_pcm(path, np.zeros(1600, dtype=np.int32), 16000)
    place(root, path)
    wrong = ToolVersions(versions.service, versions.python, "0.0.1", versions.numpy)
    for ctx, vers, code in (
        (make_context(config_for(versions), prefix=f"derived/{WS}/{REC}/{'1' * 64}"), versions,
         ErrorCode.CONFIG_HASH_MISMATCH),
        (make_context(config_for(versions)), wrong, ErrorCode.TOOL_VERSION_MISMATCH),
    ):  # fmt: skip
        with pytest.raises(Exception) as raised:  # noqa: PT011
            handler(root, runner, vers)(ctx)
        assert getattr(raised.value, "code", None) is code
    assert children() == [] and temp_dirs(root) == []


# -- damaged input -------------------------------------------------------------------------------


def test_a_truncated_flac_is_partial_and_the_measurements_cover_only_what_decoded(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    path = tmp_path / "t.flac"
    lab.make_flac(path, 16000, 1, 16, noise=0.01)
    full_samples = 32000
    lab.truncate(path, 0.6)
    result = preprocess(runner, versions, root, path)
    parsed = PreprocessResult.model_validate(result)
    assert parsed.timeline.decodeClass == "partial"
    assert 0 < parsed.canonical.samples < full_samples * 0.7
    assert parsed.measurements[1].frames == parsed.canonical.samples
    assert parsed.measurements[0].frames == parsed.timeline.decodedSamplesNative
    assert parsed.timeline.mappingStatus == "uncertain"
    assert parsed.canonical.durationMs == parsed.canonical.samples / 16


# -- cancellation ----------------------------------------------------------------------------------


def sparse_wav(path: Path, *, seconds: int, rate: int = 16000) -> None:
    size = seconds * rate * 2
    header = (
        b"RIFF" + (36 + size).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little")
        + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + rate.to_bytes(4, "little")
        + (rate * 2).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
        + b"data" + size.to_bytes(4, "little")
    )  # fmt: skip
    with path.open("wb") as handle:
        handle.write(header)
        handle.truncate(44 + size)  # a hole: reads as zeros, uses no tmpfs


class Throttled:
    """Real FFmpeg, each stdout chunk consumed slowly so a pass is long enough to cancel."""

    def __init__(self, inner: SandboxRunner, delay_s: float) -> None:
        self._inner, self._delay = inner, delay_s

    def run(self, argv: list[str], *, stdout_sink: Any, **kwargs: Any) -> Any:
        def slow(data: bytes) -> None:
            time.sleep(self._delay)
            stdout_sink(data)

        return self._inner.run(argv, stdout_sink=slow, **kwargs)


@pytest.mark.parametrize("stage", ["decode", "measure"])
def test_cancellation_mid_pass_leaves_no_process_no_temp_and_no_manifest(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path, stage: str
) -> None:
    # 60 s of audio keeps the 3x free-space precheck inside the container's small tmpfs.
    path = tmp_path / "long.wav"
    sparse_wav(path, seconds=60)
    place(root, path)
    token = CancellationToken()
    progress: list[TaskProgress] = []
    outcome: list[BaseException] = []
    config = config_for(versions)
    slow = handler(root, Throttled(runner, 0.1), versions)

    def work() -> None:
        try:
            slow(make_context(config, cancel=token, progress=progress))
        except BaseException as exc:  # noqa: BLE001 - handed to the test thread
            outcome.append(exc)

    thread = threading.Thread(target=work)
    thread.start()
    wait_for(
        lambda: bool(outcome) or any(p.stage == stage and p.processedMs > 0 for p in progress),
        timeout=60,
    )
    assert not outcome, outcome  # still running when cancelled
    asked = time.monotonic()
    token.cancel()
    thread.join(60)
    assert not thread.is_alive()
    assert len(outcome) == 1 and isinstance(outcome[0], TaskCancelled), outcome
    assert time.monotonic() - asked < 10
    assert children() == []
    assert temp_dirs(root) == []
    assert not (root / prefix_for(config) / "manifest.json").exists()
    assert list((root / prefix_for(config)).glob("*")) == []


# -- through the HTTP API ------------------------------------------------------------------------


def test_the_preprocess_task_runs_end_to_end_through_the_http_api(
    versions: ToolVersions, tmp_path: Path, token: str, auth: dict[str, str]
) -> None:
    settings = Settings(env="test", token=token, storage_root=tmp_path / "storage")
    path = tmp_path / "a.wav"
    write_pcm(path, np.round(sine(16000, 2.0, 0.25) * 32767).astype(np.int32), 16000)
    place(settings.storage_root, path)  # type: ignore[arg-type]
    config = config_for(versions)
    body = task_body(
        type="preprocess",
        config=config,
        input={
            "originalKey": f"recordings/{WS}/{REC}/original",
            "outputPrefix": prefix_for(config),
        },
    )
    with TestClient(
        create_app(settings, media_handlers=True), raise_server_exceptions=False, headers=auth
    ) as client:
        assert client.get("/v1/capabilities").json()["taskTypes"] == ["preprocess", "probe"]
        res = client.post("/v1/tasks", json=body)
        assert res.status_code == 202
        task_id = res.json()["taskId"]
        wait_for(
            lambda: client.get(f"/v1/tasks/{task_id}").json()["status"] in ("succeeded", "failed"),
            timeout=60,
        )
        state = client.get(f"/v1/tasks/{task_id}").json()
        assert state["status"] == "succeeded", state
        PreprocessResult.model_validate(state["result"])
        assert state["progress"]["stage"] == "write" and state["progress"]["fraction"] == 1.0

        bad = task_body(
            type="preprocess",
            idempotencyKey="idem-key-0002",
            config=config,
            input={
                "originalKey": f"recordings/{WS}/{REC}/original",
                "outputPrefix": f"derived/{WS}/{REC}/{'0' * 64}",
            },
        )
        failed_id = client.post("/v1/tasks", json=bad).json()["taskId"]
        wait_for(lambda: client.get(f"/v1/tasks/{failed_id}").json()["status"] == "failed")
        error = client.get(f"/v1/tasks/{failed_id}").json()["error"]
        assert error == {"code": "CONFIG_HASH_MISMATCH", "retryable": False}


def test_logs_carry_no_paths_stderr_or_measurements(
    runner: SandboxRunner,
    versions: ToolVersions,
    root: Path,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import logging

    path = tmp_path / "a.wav"
    write_pcm(path, np.round(sine(16000, 1.0, 0.25) * 32767).astype(np.int32), 16000)
    with caplog.at_level(logging.DEBUG):
        preprocess(runner, versions, root, path)
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert str(root) not in text and "LUFS" not in text and "Summary" not in text


class CgroupSampler(threading.Thread):
    """Peak of the container's anonymous memory (excludes reclaimable page cache) and of
    `memory.current` (includes it), sampled every 0.2 s. Reads cgroup v2 files; zero if absent."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.anon_mb = self.current_mb = 0.0
        self._stop_event = threading.Event()

    def run(self) -> None:
        while not self._stop_event.is_set():
            try:
                current = int(Path("/sys/fs/cgroup/memory.current").read_text())
                for line in Path("/sys/fs/cgroup/memory.stat").read_text().splitlines():
                    if line.startswith("anon "):
                        self.anon_mb = max(self.anon_mb, int(line.split()[1]) / 2**20)
                self.current_mb = max(self.current_mb, current / 2**20)
            except (OSError, ValueError):
                return
            self._stop_event.wait(0.2)

    def stop(self) -> None:
        self._stop_event.set()
        self.join()


# -- long input (manual: needs a writable directory, see VERIFICATION_WS4.md) ------------


@pytest.mark.skipif(not LONG_DIR, reason="set AUDIO_SERVICE_TEST_LONG_DIR to a writable directory")
def test_sixty_minutes_stream_in_bounded_memory(
    runner: SandboxRunner, versions: ToolVersions
) -> None:
    assert LONG_DIR is not None
    work = Path(LONG_DIR) / f"long-{os.getpid()}"
    work.mkdir()
    rate, seconds, channels = 48000, 3600, 2
    path = work / "hour.wav"
    rng = np.random.default_rng(1)
    block = (np.sin(2 * np.pi * 220 * np.arange(rate * 10) / rate) * 9000).astype("<i2")
    stereo = np.stack([block, block // 2], axis=1)
    data_bytes = seconds * rate * channels * 2
    with path.open("wb") as handle:
        handle.write(
            b"RIFF" + (36 + data_bytes).to_bytes(4, "little") + b"WAVEfmt "
            + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
            + channels.to_bytes(2, "little")
            + rate.to_bytes(4, "little") + (rate * channels * 2).to_bytes(4, "little")
            + (channels * 2).to_bytes(2, "little") + (16).to_bytes(2, "little")
            + b"data" + data_bytes.to_bytes(4, "little")
        )  # fmt: skip
        for _ in range(seconds // 10):
            noise = rng.integers(-300, 300, size=stereo.shape, dtype=np.int16)
            handle.write((stereo + noise).astype("<i2").tobytes())
    root = work / "storage"
    before_self = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    cgroup = CgroupSampler()
    cgroup.start()
    started = time.monotonic()
    result = preprocess(runner, versions, root, path, config_for(versions, blockSeconds=10))
    took = time.monotonic() - started
    cgroup.stop()
    self_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    child_mb = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
    peak = ""
    for candidate in (
        "/sys/fs/cgroup/memory.peak",
        "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
    ):
        try:
            peak = f"{int(Path(candidate).read_text()) / 2**20:.1f}"
            break
        except (OSError, ValueError):
            continue
    parsed = PreprocessResult.model_validate(result)
    print(  # noqa: T201
        f"LONG_60MIN_SECONDS={took:.1f} PYTHON_PEAK_RSS_MB={self_mb:.1f} "
        f"PYTHON_RSS_GROWTH_MB={self_mb - before_self:.1f} CHILD_PEAK_RSS_MB={child_mb:.1f} "
        f"CGROUP_PEAK_MB={peak} CGROUP_ANON_PEAK_MB={cgroup.anon_mb:.1f} "
        f"CGROUP_CURRENT_PEAK_MB={cgroup.current_mb:.1f} "
        f"CANONICAL_SAMPLES={parsed.canonical.samples} "
        f"MAPPING={parsed.timeline.mappingStatus}"
    )
    assert parsed.canonical.samples == seconds * 16000
    assert parsed.timeline.decodedSamplesNative == seconds * rate
    assert parsed.canonical.durationMs == seconds * 1000
    assert self_mb - before_self < 128


# -- speech segmentation through a test-only detector (WS6; OD-29 and OD-10 Open) ----------------

BURSTS = ((2.0, 3.5), (6.0, 7.0))  # seconds


def burst_codes(rate: int, seconds: float = 10.0) -> Any:
    signal = np.zeros(int(rate * seconds))
    for start, end in BURSTS:
        a, b = int(start * rate), int(end * rate)
        signal[a:b] = sine(rate, end - start, 0.5, 440)
    return np.round(signal * 32767).astype(np.int32)


def segmented_config_for(versions: ToolVersions) -> dict[str, Any]:
    return make_config(
        vad={"method": fakes.METHOD},
        segmentation=dict(fakes.SEGMENTATION),
        toolVersions={**versions.as_dict(), "vad": fakes.TOOL_VERSION},
    )


def segmented(
    runner: Any, versions: ToolVersions, root: Path, source: Path
) -> tuple[dict[str, Any], dict[str, Any]]:
    storage = LocalStorageBackend(root)
    detecting = PreprocessHandler(
        lambda: storage,
        lambda: runner,
        lambda: versions,
        max_duration_ms=14_400_000,
        max_channels=8,
        max_sample_rate_hz=192_000,
        detectors={fakes.METHOD: fakes.ThresholdVad},
    )
    place(root, source)
    config = segmented_config_for(versions)
    return detecting(make_context(config)), config


@pytest.mark.parametrize("rate", [16000, 48000])
def test_segments_land_on_the_bursts_and_each_has_measurements(
    runner: SandboxRunner, versions: ToolVersions, tmp_path: Path, rate: int
) -> None:
    path = tmp_path / "bursts.wav"
    write_pcm(path, burst_codes(rate), rate)
    document, _ = segmented(runner, versions, tmp_path / "root", path)
    result = PreprocessResult.model_validate(document)
    tolerance = 0 if rate == 16000 else 10  # a resampler can move a burst edge by one frame
    expected = [(1800, 3700), (5800, 7200)]
    assert len(result.segments) == 2
    for seg, (start, end) in zip(result.segments, expected, strict=True):
        assert abs(seg.startMs - start) <= tolerance and abs(seg.endMs - end) <= tolerance
    assert [m.segmentIndex for m in result.segmentMeasurements] == [0, 1]
    for seg, linked in zip(result.segments, result.segmentMeasurements, strict=True):
        assert linked.record.source == "canonical"
        assert linked.record.quantities["speechMs"].value == seg.speechMs
        assert linked.record.frames == (seg.endMs - seg.startMs) * 16
    assert result.vad.status == "applied"
    assert temp_dirs(tmp_path / "root") == []


def test_the_segmented_output_is_deterministic(
    runner: SandboxRunner, versions: ToolVersions, tmp_path: Path
) -> None:
    runs = []
    for name in ("one", "two"):
        path = tmp_path / f"{name}.wav"
        write_pcm(path, burst_codes(16000), 16000)
        document, config = segmented(runner, versions, tmp_path / name, path)
        out = tmp_path / name / prefix_for(config)
        files = {p.name: p.read_bytes() for p in sorted(out.iterdir()) if p.is_file()}
        runs.append((json.dumps(document, sort_keys=True), files))
    assert runs[0] == runs[1]  # same canonical SHA-256, segments and measurements
    assert runs[0][0] == json.dumps(json.loads(runs[0][0]), sort_keys=True)


def test_vad_none_keeps_the_ws4_behaviour(
    runner: SandboxRunner, versions: ToolVersions, root: Path, tmp_path: Path
) -> None:
    path = tmp_path / "bursts.wav"
    write_pcm(path, burst_codes(16000), 16000)
    result = preprocess(runner, versions, root, path)
    assert result["vad"] == {"method": "none", "status": "not_configured"}
    assert result["segments"] == [] and result["segmentMeasurements"] == []
    assert len(result["measurements"]) == 2
    assert "segmentation" not in config_for(versions)
