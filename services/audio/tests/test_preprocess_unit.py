"""The preprocess handler against scripted media: real storage and analysers, no FFmpeg."""

from __future__ import annotations

import errno
import hashlib
import json
import re
import wave
from pathlib import Path
from typing import IO, Any

import numpy as np
import pytest
import test_segmentation_fakes as fakes
from helpers import REC, WS
from preprocess_fakes import (
    VERSIONS,
    Media,
    handler,
    make_config,
    make_context,
    packet_scan,
    prefix_for,
    probe_result,
    put_original,
)

from audio_service.contracts import (
    ErrorCode,
    LevelSeries,
    PreprocessResult,
    TaskProgress,
    config_hash,
)
from audio_service.domain import preprocess as module
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.preprocess import PreprocessHandler, ToolVersions
from audio_service.domain.storage import LocalStorageBackend, OutputSession
from audio_service.domain.tasks import CancellationToken

RATE = 16000
FORBIDDEN_KEY = re.compile(r"quality|score|grade|verdict|recommend|rating|severity|diagnos", re.I)


def tone(seconds: float = 2.0, amplitude: float = 0.5, hz: int = 440, rate: int = RATE) -> Any:
    t = np.arange(int(rate * seconds)) / rate
    return amplitude * np.sin(2 * np.pi * hz * t)


def media(seconds: float = 2.0, **kw: Any) -> Media:
    return Media.from_signal(tone(seconds), RATE, **kw)


class Env:
    """A storage root with an original in place and the probe/scan steps patched."""

    def __init__(self, root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        self.root = root
        self.monkeypatch = monkeypatch
        put_original(root)

    def patch(self, *, probe: Any = None, scan: Any = "auto") -> None:
        probe = probe or probe_result()
        frames = (
            probe.headerDurationMs * probe.sampleRateHz // 1000 if probe.headerDurationMs else 0
        )
        found = packet_scan(probe.sampleRateHz, frames) if scan == "auto" else scan

        def fake_scan(*_a: Any, **_k: Any) -> Any:
            if isinstance(found, Exception):
                raise found
            return found

        self.monkeypatch.setattr(module, "probe_media", lambda *_a, **_k: probe)
        self.monkeypatch.setattr(module, "scan_packets", fake_scan)

    def run(self, source: Media, config: dict[str, Any] | None = None, **kw: Any) -> dict[str, Any]:
        cfg = make_config() if config is None else config
        ctx = make_context(
            cfg,
            prefix=kw.pop("prefix", None),
            cancel=kw.pop("cancel", None),
            progress=kw.pop("progress", None),
        )
        h = kw.pop("handler", None) or handler(self.root, source.runner(), **kw)
        return h(ctx)

    def published(self, config: dict[str, Any] | None = None) -> Path:
        return self.root / prefix_for(config or make_config())


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Env:
    e = Env(tmp_path / "storage", monkeypatch)
    e.patch()
    return e


def temp_dirs(root: Path) -> list[Path]:
    return [p for p in root.rglob(".tmp-*")]


def fail_code(env: Env, source: Media, **kw: Any) -> ErrorCode:
    with pytest.raises(TaskFailure) as raised:
        env.run(source, **kw)
    return raised.value.code


def keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [*value, *(k for v in value.values() for k in keys(v))]
    if isinstance(value, list):
        return [k for v in value for k in keys(v)]
    return []


# -- outputs -------------------------------------------------------------------------------------


def test_result_validates_and_every_artifact_is_published_with_a_manifest(env: Env) -> None:
    result = env.run(media())
    parsed = PreprocessResult.model_validate(result)
    out = env.published()
    manifest = json.loads((out / "manifest.json").read_bytes())
    assert {f["name"] for f in manifest["files"]} == {
        "canonical.wav",
        "level-series.json",
        "result.json",
    }
    for entry in manifest["files"]:
        data = (out / entry["name"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"]
        assert len(data) == entry["bytes"]
    assert parsed.canonical.key == f"{prefix_for(make_config())}/canonical.wav"
    assert parsed.artifacts.manifestKey == f"{prefix_for(make_config())}/manifest.json"
    assert parsed.vad.model_dump() == {"method": "none", "status": "not_configured"}
    assert parsed.segments == []
    assert [m.source for m in parsed.measurements] == ["original_decoded", "canonical"]
    assert temp_dirs(env.root) == []
    assert oct((out / "canonical.wav").stat().st_mode & 0o777) == "0o600"


def test_canonical_wav_is_a_valid_16khz_mono_s16_file_whose_length_is_the_sample_count(
    env: Env,
) -> None:
    source = media(2.5)
    result = PreprocessResult.model_validate(env.run(source))
    path = env.published() / "canonical.wav"
    with wave.open(str(path)) as wav:
        assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate()) == (1, 2, 16000)
        frames = wav.getnframes()
        pcm = np.frombuffer(wav.readframes(frames), dtype="<i2")
    assert frames == result.canonical.samples == source.canonical.size == 40_000
    assert np.array_equal(pcm, source.canonical)
    assert result.canonical.durationMs == frames / 16 == result.timeline.canonicalSamples / 16
    assert result.canonical.bytes == path.stat().st_size == 44 + 2 * frames
    assert result.canonical.sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    canonical_record = result.measurements[1]
    assert canonical_record.quantities["sampleCount"].value == frames
    assert canonical_record.frames == frames


def test_riff_header_sizes_are_patched(env: Env) -> None:
    env.run(media(1.0))
    raw = (env.published() / "canonical.wav").read_bytes()
    assert raw[:4] == b"RIFF" and raw[8:16] == b"WAVEfmt "
    assert int.from_bytes(raw[4:8], "little") == len(raw) - 8
    assert raw[36:40] == b"data" and int.from_bytes(raw[40:44], "little") == len(raw) - 44


def test_level_series_artifact_matches_the_window_count(env: Env) -> None:
    result = PreprocessResult.model_validate(env.run(media(2.0)))
    series = LevelSeries.model_validate_json((env.published() / "level-series.json").read_bytes())
    assert series.intervalMs == 100 and series.windows == 20 == len(series.rmsDbfs)
    assert result.measurements[1].quantities["silenceRatio"].value == 0.0


def test_original_record_reports_the_native_pass_and_loudness(env: Env) -> None:
    result = PreprocessResult.model_validate(env.run(media()))
    original = result.measurements[0]
    assert original.sampleRateHz == RATE and original.channels == 1
    assert float(original.quantities["peakDbfs"].value) == pytest.approx(-6.02, abs=0.01)
    assert float(original.quantities["rmsDbfs"].value) == pytest.approx(-9.03, abs=0.01)
    assert original.quantities["integratedLoudnessLufs"].value == -20.5
    assert original.quantities["loudnessRangeLu"].unit == "LU"
    assert original.quantities["truePeakDbtp"].unit == "dBTP"
    assert original.perChannel[0].quantities["dcOffset"].kind == "measured"


def test_stereo_source_has_per_channel_records_and_a_correlation(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    left = tone(2.0, 0.6)
    source = Media.from_signal(np.stack([left, -0.5 * left], axis=1), RATE)
    env.patch(probe=probe_result(channels=2))
    result = PreprocessResult.model_validate(env.run(source))
    original = result.measurements[0]
    assert original.channels == 2 and len(original.perChannel) == 2
    assert original.quantities["correlationCh0Ch1"].value == -1.0


def test_no_judgement_keys_anywhere_in_the_result_or_the_series(env: Env) -> None:
    result = env.run(media())
    series = json.loads((env.published() / "level-series.json").read_bytes())
    assert [k for k in keys(result) + keys(series) if FORBIDDEN_KEY.search(k)] == []
    for record in result["measurements"]:
        for q in record["quantities"].values():
            assert set(q) == {"value", "unit", "kind", "method"}
            assert q["kind"] in {"measured", "derived", "estimate"}


def test_progress_reports_probe_decode_measure_write(env: Env) -> None:
    progress: list[TaskProgress] = []
    env.run(media(), progress=progress)
    stages = [p.stage for p in progress]
    assert [s for i, s in enumerate(stages) if i == 0 or s != stages[i - 1]] == [
        "probe",
        "decode",
        "measure",
        "write",
    ]
    decode = [p for p in progress if p.stage == "decode"]
    assert decode[-1].processedMs == 2000 and decode[-1].fraction == 1.0
    assert progress[-1].stage == "write" and progress[-1].fraction == 1.0


# -- determinism and reuse -----------------------------------------------------------------------


def test_same_input_and_config_give_identical_outputs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outputs = []
    for name in ("one", "two"):
        e = Env(tmp_path / name, monkeypatch)
        e.patch()
        result = e.run(media())
        files = {p.name: p.read_bytes() for p in sorted(e.published().iterdir()) if p.is_file()}
        outputs.append((json.dumps(result, sort_keys=True), files))
    assert outputs[0][0] == outputs[1][0]  # identical measurement JSON, hashes included
    assert outputs[0][1] == outputs[1][1]  # canonical.wav, level series, result and manifest


def test_a_published_result_is_reused_without_running_ffmpeg(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = env.run(media())
    silent = media()
    silent.calls.clear()

    def forbidden(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("must not probe or decode on reuse")

    monkeypatch.setattr(module, "probe_media", forbidden)
    monkeypatch.setattr(module, "scan_packets", forbidden)
    runner = silent.runner()
    second = env.run(silent, handler=handler(env.root, runner))
    assert second == first
    assert runner.calls == [] and silent.calls == []


def test_a_damaged_canonical_file_is_not_reused_and_is_recomputed(env: Env) -> None:
    first = env.run(media())
    wav = env.published() / "canonical.wav"
    data = bytearray(wav.read_bytes())
    data[100] ^= 0xFF
    wav.write_bytes(bytes(data))
    source = media()
    second = env.run(source)
    assert second == first and source.calls  # recomputed: FFmpeg ran
    assert hashlib.sha256(wav.read_bytes()).hexdigest() == first["canonical"]["sha256"]


@pytest.mark.parametrize("damage", ["manifest", "extra_file", "result"])
def test_incomplete_or_foreign_outputs_are_recomputed(env: Env, damage: str) -> None:
    first = env.run(media())
    out = env.published()
    if damage == "manifest":
        (out / "manifest.json").unlink()
    elif damage == "extra_file":
        manifest = json.loads((out / "manifest.json").read_bytes())
        manifest["files"].append({"name": "other.bin", "sha256": "0" * 64, "bytes": 0})
        (out / "manifest.json").write_text(json.dumps(manifest))
    else:
        (out / "result.json").write_text("{}")
    source = media()
    assert env.run(source) == first and source.calls


# -- integrity checks before any work ------------------------------------------------------------


def test_a_config_hash_that_does_not_match_the_prefix_is_rejected_before_any_work(
    env: Env,
) -> None:
    source = media()
    config = make_config()
    ctx = make_context(config, prefix=f"derived/{WS}/{REC}/{'0' * 64}")
    runner = source.runner()
    with pytest.raises(TaskFailure) as raised:
        handler(env.root, runner)(ctx)
    assert raised.value.code is ErrorCode.CONFIG_HASH_MISMATCH
    assert runner.calls == [] and not (env.root / "derived").exists()


def test_a_hash_computed_from_a_different_config_is_a_mismatch(env: Env) -> None:
    other = make_config(measurement__silenceThresholdCentiDbfs=-6000)
    ctx = make_context(make_config(), prefix=prefix_for(other))
    with pytest.raises(TaskFailure) as raised:
        handler(env.root, media().runner())(ctx)
    assert raised.value.code is ErrorCode.CONFIG_HASH_MISMATCH


@pytest.mark.parametrize(
    "versions",
    [
        ToolVersions("0.1.1", "3.12.8", "7.1.2", "2.5.5"),
        ToolVersions("0.1.0", "3.12.9", "7.1.2", "2.5.5"),
        ToolVersions("0.1.0", "3.12.8", "7.1.3", "2.5.5"),
        ToolVersions("0.1.0", "3.12.8", "7.1.2", "2.5.6"),
        None,
    ],
)
def test_tool_versions_must_equal_the_services_own(env: Env, versions: ToolVersions | None) -> None:
    source = media()
    runner = source.runner()
    ctx = make_context(make_config())
    with pytest.raises(TaskFailure) as raised:
        handler(env.root, runner, versions=versions)(ctx)
    assert raised.value.code is ErrorCode.TOOL_VERSION_MISMATCH
    assert runner.calls == [] and not (env.root / "derived").exists()


@pytest.mark.parametrize(
    "config",
    [
        make_config(measurement__silenceThresholdCentiDbfs=-50.5),
        make_config(vad__method="silero"),
        make_config(canonical__sampleRateHz=44100),
        make_config(measurement__levelSeriesIntervalMs=True),
        {**make_config(), "extra": 1},
        {},
    ],
)
def test_an_invalid_config_is_rejected(env: Env, config: dict[str, Any]) -> None:
    prefix = f"derived/{WS}/{REC}/{'a' * 64}"  # the hash cannot even be computed for some of these
    assert fail_code(env, media(), config=config, prefix=prefix) is ErrorCode.INVALID_CONFIG


def test_limits_above_the_service_ceiling_are_refused(env: Env) -> None:
    config = make_config(limits__maxChannels=9)
    ctx = make_context(config)
    with pytest.raises(TaskFailure) as raised:
        handler(env.root, media().runner())(ctx)
    assert raised.value.code is ErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_the_config_hash_rule_is_used_for_the_prefix(env: Env) -> None:
    config = make_config()
    reordered = json.loads(json.dumps(config, sort_keys=True))
    assert config_hash(config) == config_hash(reordered)
    assert PreprocessResult.model_validate(env.run(media(), config=reordered))


# -- cancellation and failures -------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["native", "canonical"])
def test_cancellation_mid_pass_discards_everything(env: Env, mode: str) -> None:
    token = CancellationToken()

    def trigger(current: str, index: int) -> None:
        if current == mode and index == 2:
            token.cancel()

    source = media(on_chunk=trigger)
    with pytest.raises(TaskCancelled):
        env.run(source, cancel=token)
    assert temp_dirs(env.root) == []
    assert not (env.published() / "manifest.json").exists()
    assert list(env.published().glob("*")) == []  # not even a partial output


def test_a_cancelled_task_leaves_an_earlier_complete_output_untouched(env: Env) -> None:
    env.run(media())
    before = (env.published() / "manifest.json").read_bytes()
    token = CancellationToken()
    token.cancel()
    with pytest.raises(TaskCancelled):
        env.run(media(), cancel=token)
    assert (env.published() / "manifest.json").read_bytes() == before


class _BrokenHandle:
    def __init__(self, inner: IO[bytes], error: int) -> None:
        self._inner, self._error = inner, error

    def write(self, data: bytes) -> int:
        raise OSError(self._error, "injected")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


class FailingStorage(LocalStorageBackend):
    def __init__(self, root: Path, *, write_error: int = 0, publish_error: bool = False) -> None:
        super().__init__(root)
        self.write_error, self.publish_error = write_error, publish_error

    def begin_output(self, prefix: str, refs: Any, task_id: Any) -> OutputSession:
        session = super().begin_output(prefix, refs, task_id)
        if self.write_error:
            create, error = session.create_file, self.write_error
            session.create_file = lambda name: _BrokenHandle(create(name), error)  # type: ignore[method-assign]
        if self.publish_error:

            def broken() -> dict[str, Any]:
                session.close()
                raise TaskFailure(ErrorCode.STORAGE_ERROR)

            session.publish = broken  # type: ignore[method-assign]
        return session


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (errno.EIO, ErrorCode.STORAGE_ERROR),
        (errno.ENOSPC, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
        (errno.EDQUOT, ErrorCode.RESOURCE_LIMIT_EXCEEDED),
    ],
)
def test_a_storage_write_error_maps_to_a_code_and_removes_the_temp_directory(
    env: Env, error: int, code: ErrorCode
) -> None:
    storage = FailingStorage(env.root, write_error=error)
    source = media()
    assert (
        fail_code(env, source, handler=handler(env.root, source.runner(), storage=storage)) == code
    )
    assert temp_dirs(env.root) == []
    assert not (env.published() / "manifest.json").exists()


def test_a_publish_failure_leaves_no_manifest_and_no_temp(env: Env) -> None:
    storage = FailingStorage(env.root, publish_error=True)
    source = media()
    code = fail_code(env, source, handler=handler(env.root, source.runner(), storage=storage))
    assert code is ErrorCode.STORAGE_ERROR
    assert temp_dirs(env.root) == [] and not (env.published() / "manifest.json").exists()


def test_the_free_space_precheck_stops_before_any_decoding(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[int] = []

    def full(self: Any, required: int) -> None:
        seen.append(required)
        raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)

    monkeypatch.setattr(LocalStorageBackend, "ensure_free_space", full)
    source = media()
    assert fail_code(env, source) is ErrorCode.RESOURCE_LIMIT_EXCEEDED
    assert seen == [3 * (2000 * 32 + 44)]  # three times the expected canonical size
    assert source.calls == [] and temp_dirs(env.root) == []


def test_the_byte_budget_aborts_a_decode_that_outgrows_the_expected_size(env: Env) -> None:
    env.patch(probe=probe_result(duration_ms=1000))  # header and packets say 1 s ...
    source = Media.from_signal(tone(8.0), RATE)  # ... the decoder produces 8 s
    assert fail_code(env, source) is ErrorCode.RESOURCE_LIMIT_EXCEEDED
    assert temp_dirs(env.root) == [] and not (env.published() / "manifest.json").exists()


def test_a_duration_the_packets_show_over_the_limit_is_refused(env: Env) -> None:
    probe = probe_result(duration_ms=1000)
    env.patch(probe=probe, scan=packet_scan(RATE, 3 * RATE))
    config = make_config(limits__maxDurationMs=2000)
    assert fail_code(env, media(), config=config) is ErrorCode.DURATION_LIMIT_EXCEEDED


def test_nothing_decoded_fails_with_a_code_and_leaves_nothing(env: Env) -> None:
    source = Media(RATE, np.zeros((0, 1), dtype=np.float32), np.zeros(0, dtype=np.int16))
    assert fail_code(env, source) is ErrorCode.NO_DECODABLE_AUDIO
    assert temp_dirs(env.root) == []


def test_a_corrupt_packet_scan_degrades_the_timeline_instead_of_failing(
    env: Env,
) -> None:
    env.patch(scan=TaskFailure(ErrorCode.CORRUPT_MEDIA))
    result = PreprocessResult.model_validate(env.run(media()))
    assert "packet_scan_unavailable" in result.warnings
    assert result.timeline.mappingStatus == "uncertain"


def test_a_scan_timeout_still_fails_the_task(env: Env) -> None:
    env.patch(scan=TaskFailure(ErrorCode.TIMEOUT))
    assert fail_code(env, media()) is ErrorCode.TIMEOUT


# -- partial decode and loudness -----------------------------------------------------------------


def test_a_partial_decode_covers_only_the_decoded_audio(env: Env) -> None:
    full = tone(2.0)
    source = Media.from_signal(full, RATE, canonical_rc=1)
    source.native = source.native[:RATE]  # the decoder stopped after 1 s of 2 s
    source.canonical = source.canonical[:RATE]
    result = PreprocessResult.model_validate(env.run(source))
    assert result.timeline.decodeClass == "partial"
    assert result.canonical.samples == RATE and result.canonical.durationMs == 1000.0
    assert result.measurements[0].frames == RATE
    assert result.measurements[1].frames == RATE
    assert result.timeline.decodedUntilMs == 1000.0
    assert result.timeline.mappingStatus == "uncertain"


def test_loudness_is_unavailable_with_a_reason_when_the_summary_is_missing(env: Env) -> None:
    result = PreprocessResult.model_validate(env.run(media(summary=b"nothing useful here")))
    original = result.measurements[0]
    assert "integratedLoudnessLufs" not in original.quantities
    reasons = {u.name: u.reason for u in original.unavailable}
    assert reasons["integratedLoudnessLufs"] == "summary_not_found"
    assert result.timeline.decodeClass == "full"


def test_a_failed_loudness_pass_does_not_fail_the_task(env: Env) -> None:
    result = PreprocessResult.model_validate(env.run(media(loudness_rc=1)))
    reasons = {u.name: u.reason for u in result.measurements[0].unavailable}
    assert reasons["truePeakDbtp"] == "loudness_pass_failed"


def test_the_output_prefix_trailing_slash_is_tolerated(env: Env) -> None:
    config = make_config()
    ctx = make_context(config, prefix=prefix_for(config) + "/")
    result = PreprocessResult.model_validate(handler(env.root, media().runner())(ctx))
    assert result.canonical.key == f"{prefix_for(config)}/canonical.wav"


# -- speech segmentation through a test-only detector (WS6; OD-29 and OD-10 Open) ----------------

BURSTS = ((2.0, 3.5), (6.0, 7.0))  # seconds, on the 10 ms grid


def burst_signal(seconds: float = 10.0, amplitude: float = 0.5) -> Any:
    signal = np.zeros(int(RATE * seconds))
    for start, end in BURSTS:
        a, b = int(start * RATE), int(end * RATE)
        signal[a:b] = tone(end - start, amplitude)
    return signal


def segmented_config(tool_version: str = fakes.TOOL_VERSION) -> dict[str, Any]:
    return make_config(
        vad={"method": fakes.METHOD},
        segmentation=dict(fakes.SEGMENTATION),
        toolVersions__vad=tool_version,
    )


def segment_handler(root: Path, source: Media, vad: Any = fakes.ThresholdVad) -> Any:
    storage = LocalStorageBackend(root)
    return PreprocessHandler(
        lambda: storage,
        source.runner,
        lambda: VERSIONS,
        max_duration_ms=14_400_000,
        max_channels=8,
        max_sample_rate_hz=192_000,
        detectors={fakes.METHOD: vad},
    )


def run_segmented(
    env: Env, config: dict[str, Any] | None = None, signal: Any = None, **kw: Any
) -> dict[str, Any]:
    source = Media.from_signal(burst_signal() if signal is None else signal, RATE)
    env.patch(probe=probe_result(duration_ms=round(len(source.canonical) / 16)))
    cfg = config or segmented_config()
    return env.run(source, cfg, handler=segment_handler(env.root, source, **kw))


def test_segments_land_on_the_bursts_with_exact_padding(env: Env) -> None:
    result = PreprocessResult.model_validate(run_segmented(env))
    assert result.vad.method == fakes.METHOD
    assert result.vad.status == "applied" and result.vad.version == "1"  # type: ignore[union-attr]
    assert [(s.startMs, s.endMs) for s in result.segments] == [(1800, 3700), (5800, 7200)]
    assert [s.speechMs for s in result.segments] == [1500, 1000]
    assert [s.index for s in result.segments] == [0, 1]
    assert all(s.overlapStartMs == s.overlapEndMs == 0 for s in result.segments)
    assert not any(s.containsSyntheticGap for s in result.segments)
    assert result.toolVersions.vad == fakes.TOOL_VERSION


def test_each_segment_has_a_canonical_measurement_record_linked_by_index(env: Env) -> None:
    result = PreprocessResult.model_validate(run_segmented(env))
    assert [m.segmentIndex for m in result.segmentMeasurements] == [0, 1]
    for seg, linked in zip(result.segments, result.segmentMeasurements, strict=True):
        record = linked.record
        assert record.source == "canonical" and record.perChannel == []
        q = record.quantities
        assert q["sampleCount"].value == (seg.endMs - seg.startMs) * 16 == record.frames
        assert q["speechMs"].value == seg.speechMs and q["speechMs"].unit == "ms"
        assert q["peakDbfs"].value == pytest.approx(-6.021, abs=0.01)  # a 0.5 amplitude tone
        assert q["rmsDbfs"].unit == "dBFS" and q["rmsDbfs"].kind == "measured"
    assert len(result.measurements) == 2  # the whole-recording records are unchanged
    assert not FORBIDDEN_KEY.search(" ".join(keys(result.model_dump(mode="json"))))


def test_the_segmented_output_is_deterministic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outputs = []
    for name in ("one", "two"):
        e = Env(tmp_path / name, monkeypatch)
        result = run_segmented(e)
        files = {p.name: p.read_bytes() for p in sorted(e.published(segmented_config()).iterdir())}
        outputs.append((json.dumps(result, sort_keys=True), files))
    assert outputs[0] == outputs[1]
    stored = json.loads((e.published(segmented_config()) / "result.json").read_text())
    assert stored["segments"] and stored["segmentMeasurements"]  # result.json carries them


def test_no_speech_gives_applied_vad_and_no_segments(env: Env) -> None:
    result = PreprocessResult.model_validate(run_segmented(env, signal=np.zeros(RATE * 3)))
    assert result.vad.status == "applied"
    assert result.segments == [] and result.segmentMeasurements == []


def test_a_gap_filled_by_the_timeline_flags_the_segment(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    from audio_service.contracts import TimelineGap

    real = module.build_timeline

    def with_gap(*args: Any) -> Any:
        timeline = real(*args)
        gap = TimelineGap(startMs=2500.0, durationMs=40.0, kind="timestamp_gap_filled")
        return timeline.model_copy(update={"gaps": [gap]})

    monkeypatch.setattr(module, "build_timeline", with_gap)
    result = PreprocessResult.model_validate(run_segmented(env))
    assert [s.containsSyntheticGap for s in result.segments] == [True, False]


def test_a_long_burst_is_split_with_a_declared_overlap(env: Env) -> None:
    config = segmented_config()
    config["segmentation"] = {
        **fakes.SEGMENTATION,
        "maxSegmentMs": 3000,
        "paddingMs": 0,
        "forcedSplitOverlapMs": 750,
    }
    result = PreprocessResult.model_validate(run_segmented(env, config, tone(8.0)))
    first, second = result.segments[0], result.segments[1]
    assert first.overlapEndMs == second.overlapStartMs == 750
    assert second.startMs == first.endMs - 750
    assert all(s.endMs - s.startMs <= 3000 for s in result.segments)
    assert result.segments[0].startMs == 0 and result.segments[-1].endMs == 8000


def test_vad_none_is_unchanged_and_has_no_segments(env: Env) -> None:
    result = env.run(media())
    assert result["vad"] == {"method": "none", "status": "not_configured"}
    assert result["segments"] == [] and result["segmentMeasurements"] == []
    assert result["toolVersions"]["vad"] == "none"
    assert "segmentation" not in make_config()  # so the hash of a `none` config is unchanged


def test_a_registered_detector_is_not_consulted_for_a_none_config(env: Env) -> None:
    def forbidden() -> Any:
        raise AssertionError("a detector was created")

    source = media()
    result = env.run(source, handler=segment_handler(env.root, source, vad=forbidden))
    assert result["vad"]["method"] == "none"


@pytest.mark.parametrize(
    "config",
    [
        make_config(
            vad={"method": "silero"}, segmentation=dict(fakes.SEGMENTATION)
        ),  # unregistered
        make_config(segmentation=dict(fakes.SEGMENTATION)),  # segmentation without a method
        make_config(vad={"method": fakes.METHOD}),  # a method without segmentation
    ],
    ids=["unregistered-method", "segmentation-without-vad", "vad-without-segmentation"],
)
def test_an_invalid_segmentation_config_is_rejected_before_any_work(
    env: Env, config: dict[str, Any]
) -> None:
    source = media()
    with pytest.raises(TaskFailure) as raised:
        env.run(source, config, handler=segment_handler(env.root, source))
    assert raised.value.code is ErrorCode.INVALID_CONFIG
    assert source.calls == [] and temp_dirs(env.root) == []


def test_an_explicit_null_segmentation_is_an_invalid_config() -> None:
    with pytest.raises(TaskFailure) as raised:
        module.parse_config({**make_config(vad={"method": "none"}), "segmentation": None})
    assert raised.value.code is ErrorCode.INVALID_CONFIG


def test_the_service_without_detectors_refuses_every_method_but_none(env: Env) -> None:
    code = fail_code(env, media(), config=segmented_config())
    assert code is ErrorCode.INVALID_CONFIG


def test_the_detector_version_is_part_of_the_tool_versions(env: Env) -> None:
    config = segmented_config("example-vad:2")
    source = media()
    with pytest.raises(TaskFailure) as raised:
        env.run(source, config, handler=segment_handler(env.root, source))
    assert raised.value.code is ErrorCode.TOOL_VERSION_MISMATCH
    assert source.calls == []


class _ShortVad(fakes.ThresholdVad):
    def feed(self, block: Any) -> Any:
        return super().feed(block)[1:]  # one frame fewer per block than the timeline has


class _MisnamedVad(fakes.ThresholdVad):
    name = "other-vad"


@pytest.mark.parametrize("vad", [_ShortVad, _MisnamedVad], ids=["frame-count", "name"])
def test_a_detector_that_breaks_its_contract_fails_the_task_cleanly(env: Env, vad: Any) -> None:
    with pytest.raises(TaskFailure) as raised:
        run_segmented(env, vad=vad)
    assert raised.value.code is ErrorCode.INTERNAL_ERROR
    assert (
        temp_dirs(env.root) == []
        and not (env.published(segmented_config()) / "manifest.json").exists()
    )


def test_cancellation_during_segmented_decoding_discards_everything(env: Env) -> None:
    cancel = CancellationToken()
    source = Media.from_signal(
        burst_signal(), RATE, on_chunk=lambda _m, i: cancel.cancel() if i == 3 else None
    )
    env.patch(probe=probe_result(duration_ms=10000))
    with pytest.raises(TaskCancelled):
        env.run(
            source, segmented_config(), cancel=cancel, handler=segment_handler(env.root, source)
        )
    assert temp_dirs(env.root) == []
