"""Phase 2B review remediation: unit tests (fake runners, real storage). Each one fails without
its fix; see VERIFICATION_REMEDIATION.md for the mutation record."""

from __future__ import annotations

import json
import os
import shutil
import signal
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
import test_probe_unit as probe_tests
from helpers import CONFIG_HASH, REC, WS, task_request, wait_for
from media_fakes import FakeRunner, probe_json, result
from preprocess_fakes import handler as preprocess_handler
from preprocess_fakes import make_config, make_context
from test_preprocess_unit import Env, media, temp_dirs

from audio_service.contracts import ErrorCode
from audio_service.domain import runner as runner_module
from audio_service.domain.decoder import DecodeMode, StreamedDecoder
from audio_service.domain.errors import TaskFailure, is_retryable
from audio_service.domain.media_io import raise_for_outcome, signal_failure_code
from audio_service.domain.runner import Outcome, RunResult, SandboxError, SandboxRunner
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.storage_keys import TaskRefs
from audio_service.domain.tasks import (
    DEADLINE_BASE_MS,
    DEADLINE_PER_AUDIO_PERMILLE,
    TaskContext,
    TaskDeadline,
    TaskExecutor,
)

# -- 1. signal-killed children are not file properties ---------------------------------------------

KILLERS = [signal.SIGKILL, signal.SIGSEGV, signal.SIGABRT, signal.SIGBUS, signal.SIGTERM]


def killed(sig: int, outcome: Outcome = Outcome.EXITED) -> RunResult:
    return RunResult(outcome, -sig, b"", 0)


@pytest.mark.parametrize("sig", KILLERS)
def test_a_signal_death_is_resource_exhausted_and_retryable(sig: int) -> None:
    assert signal_failure_code(Outcome.EXITED, -sig) is ErrorCode.RESOURCE_EXHAUSTED
    with pytest.raises(TaskFailure) as raised:
        raise_for_outcome(killed(sig))
    assert raised.value.code is ErrorCode.RESOURCE_EXHAUSTED
    assert is_retryable(ErrorCode.RESOURCE_EXHAUSTED)


def test_sigxcpu_is_the_cpu_budget_so_it_is_a_timeout() -> None:
    """Documented choice: RLIMIT_CPU is derived from the child's wall-clock timeout."""
    assert signal_failure_code(Outcome.EXITED, -signal.SIGXCPU) is ErrorCode.TIMEOUT
    assert is_retryable(ErrorCode.TIMEOUT)


@pytest.mark.parametrize("returncode", [0, 1, 183, None])
def test_a_normal_exit_status_is_never_a_signal_failure(returncode: int | None) -> None:
    assert signal_failure_code(Outcome.EXITED, returncode) is None


@pytest.mark.parametrize("outcome", [Outcome.TIMEOUT, Outcome.CANCELLED, Outcome.OUTPUT_LIMIT])
def test_signals_the_runner_sent_itself_keep_their_own_outcome_mapping(outcome: Outcome) -> None:
    """After a timeout/cancel the runner's SIGTERM/SIGKILL gives a negative code too: the outcome
    decides, not the code."""
    assert signal_failure_code(outcome, -signal.SIGKILL) is None


@pytest.mark.parametrize("sig", KILLERS)
def test_an_ffprobe_killed_by_a_signal_is_not_corrupt_media(sig: int) -> None:
    runner = probe_tests.runner_for(probe={"rc": -sig, "stderr": b""})
    assert probe_tests.code_of(runner) is ErrorCode.RESOURCE_EXHAUSTED


def test_an_ffprobe_killed_after_printing_json_is_still_not_a_file_fact() -> None:
    """A truncated or complete document with a killed process must not be trusted."""
    runner = probe_tests.runner_for(probe_json(), probe={"rc": -signal.SIGKILL, "stderr": b""})
    assert probe_tests.code_of(runner) is ErrorCode.RESOURCE_EXHAUSTED


def test_a_killed_edge_packet_scan_is_not_swallowed_as_unavailable() -> None:
    def script(argv: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        if "-read_intervals" in argv:
            return killed(signal.SIGKILL)
        sink(json.dumps(probe_json()).encode())
        return result()

    runner = FakeRunner({"ffprobe": script, "ffmpeg": probe_tests.ffmpeg_script()})
    assert probe_tests.code_of(runner) is ErrorCode.RESOURCE_EXHAUSTED


@pytest.mark.parametrize("decoded", [0, 32000])
def test_a_trial_decode_killed_by_a_signal_fails_whatever_it_had_decoded(decoded: int) -> None:
    def ffmpeg(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        if decoded:
            sink(b"\0" * decoded)
        return killed(signal.SIGKILL)

    runner = probe_tests.runner_for()
    runner.scripts["ffmpeg"] = ffmpeg
    assert probe_tests.code_of(runner) is ErrorCode.RESOURCE_EXHAUSTED


def test_a_trial_decode_with_a_normal_nonzero_exit_and_output_counts_an_error() -> None:
    runner = probe_tests.runner_for()
    runner.scripts["ffmpeg"] = lambda _a, sink, _s: (sink(b"\0" * 32000), result(rc=1))[1]
    probed = probe_tests.run_probe(runner)
    assert "trial_decode_errors" in probed.warnings and probed.trialDecode.decodable


def blocks_of(dec: StreamedDecoder) -> list[Any]:
    return list(dec.blocks())


@pytest.mark.parametrize("mode", [DecodeMode.CANONICAL, DecodeMode.NATIVE])
def test_a_decode_pass_killed_by_a_signal_raises_and_emits_no_partial_tail(
    mode: DecodeMode,
) -> None:
    frame = 2 if mode is DecodeMode.CANONICAL else 8

    def script(_a: list[str], sink: Callable[[bytes], None], _s: Any) -> RunResult:
        sink(b"\0" * (frame * 1600 + frame * 5))  # one block and a tail shorter than a block
        return killed(signal.SIGKILL)

    dec = StreamedDecoder(
        FakeRunner({"ffmpeg": script}),  # type: ignore[arg-type]
        0,
        demuxer="wav",
        mode=mode,
        sample_rate_hz=16000,
        channels=1 if mode is DecodeMode.CANONICAL else 2,
        timeout_s=30,
        block_ms=100,
    )
    with pytest.raises(TaskFailure) as raised:
        blocks_of(dec)
    assert raised.value.code is ErrorCode.RESOURCE_EXHAUSTED
    assert dec.stats.blocks <= 1  # the tail was not appended after the kill


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Env:
    e = Env(tmp_path / "storage", monkeypatch)
    e.patch()
    return e


@pytest.mark.parametrize("which", ["canonical", "native"])
def test_a_preprocess_pass_killed_by_a_signal_publishes_nothing(env: Env, which: str) -> None:
    source = media(2.0)
    if which == "canonical":
        source.canonical_rc = -signal.SIGKILL
    else:
        source.native_rc = -signal.SIGKILL
    with pytest.raises(TaskFailure) as raised:
        env.run(source)
    assert raised.value.code is ErrorCode.RESOURCE_EXHAUSTED
    assert not (env.published() / "manifest.json").exists()
    assert not env.published().exists() or not any(env.published().iterdir())
    assert temp_dirs(env.root) == []


def test_a_killed_canonical_pass_is_not_reused_by_a_later_run(env: Env) -> None:
    """The point of the fix: a killed pass must never become a version `read_verified` returns."""
    killed_source = media(2.0)
    killed_source.canonical_rc = -signal.SIGKILL
    with pytest.raises(TaskFailure):
        env.run(killed_source)
    healthy = media(2.0)
    result_ = env.run(healthy)
    assert healthy.calls.count("canonical") == 1  # recomputed, nothing was reused
    assert result_["timeline"]["decodeClass"] == "full"


# -- 2. overall task deadline (ADR-0010) ---------------------------------------------------------


class FakeClock:
    def __init__(self) -> None:
        self.now = 5000.0

    def __call__(self) -> float:
        return self.now


def test_the_deadline_formula_is_the_interim_per_child_formula_in_integers() -> None:
    assert (DEADLINE_BASE_MS, DEADLINE_PER_AUDIO_PERMILLE) == (120_000, 500)  # 120 s + 0.5 x
    clock = FakeClock()
    deadline = TaskDeadline(
        base_ms=DEADLINE_BASE_MS,
        per_audio_permille=DEADLINE_PER_AUDIO_PERMILLE,
        max_duration_ms=14_400_000,
        clock=clock,
        wall_clock=lambda: 1_000.0,
    )
    assert deadline.epoch_ms == round((1_000 + 120 + 0.5 * 14_400) * 1000)  # the ceiling at first
    deadline.tighten_for_duration(60_000)  # a 60 s recording: 120 s + 30 s
    assert deadline.epoch_ms == 1_000_000 + 150_000
    deadline.tighten_for_duration(14_400_000)  # never extended
    assert deadline.epoch_ms == 1_000_000 + 150_000
    assert not deadline.expired
    clock.now += 150.0
    assert deadline.expired


def test_a_running_task_reports_its_deadline_and_a_queued_one_does_not() -> None:
    gate = threading.Event()
    started = threading.Event()

    def handler(ctx: TaskContext) -> dict[str, Any]:
        ctx.set_audio_duration_ms(10_000)
        started.set()
        gate.wait(5)
        return {}

    executor = TaskExecutor({"probe": handler}, max_queued=2)
    executor.start()
    try:
        first = executor.submit(task_request(idempotencyKey="idem-key-0001"))
        second = executor.submit(task_request(idempotencyKey="idem-key-0002"))
        assert started.wait(5)
        running = executor.get(first.taskId)
        assert executor.get(second.taskId).deadlineAt is None  # queued
        assert running.deadlineAt is not None
        expected = (time.time() + 125) * 1000  # 120 s + 0.5 x 10 s from "now"
        assert abs(running.deadlineAt - expected) < 5_000
    finally:
        gate.set()
        executor.shutdown()


def test_a_task_past_its_deadline_fails_with_a_retryable_timeout_and_kills_its_children() -> None:
    """The handler polls the token exactly as the runner does; the executor must map it to TIMEOUT
    (not `cancelled`), and the token must be what the runner sees as cancelled."""
    seen_by_runner: list[bool] = []

    def handler(ctx: TaskContext) -> dict[str, Any]:
        ctx.set_audio_duration_ms(0)
        while not ctx.cancel.cancelled:  # the runner's loop condition
            time.sleep(0.005)
        seen_by_runner.append(True)
        ctx.check_cancelled()
        return {}

    executor = TaskExecutor(
        {"probe": handler}, deadline_base_ms=1_000, deadline_per_audio_permille=0
    )
    executor.start()
    try:
        accepted = executor.submit(task_request())
        wait_for(lambda: executor.get(accepted.taskId).status == "failed", timeout=10)
        state = executor.get(accepted.taskId)
        assert state.error is not None
        assert (state.error.code, state.error.retryable) == (ErrorCode.TIMEOUT, True)
        assert seen_by_runner == [True]
    finally:
        executor.shutdown()


def test_an_explicit_cancel_still_reports_cancelled_not_timeout() -> None:
    started = threading.Event()

    def handler(ctx: TaskContext) -> dict[str, Any]:
        started.set()
        while True:
            ctx.check_cancelled()
            time.sleep(0.005)

    executor = TaskExecutor({"probe": handler})
    executor.start()
    try:
        accepted = executor.submit(task_request())
        assert started.wait(5)
        executor.cancel(accepted.taskId)
        wait_for(lambda: executor.get(accepted.taskId).status == "cancelled")
        assert executor.get(accepted.taskId).error is not None
    finally:
        executor.shutdown()


def test_the_deadline_stops_a_real_runner_child_and_cleans_the_temp_dir(
    env: Env,
) -> None:
    """End to end with the real SandboxRunner (unconfined `sleep` stands in for FFmpeg): the
    process group dies when the deadline passes and the preprocess temp directory is removed."""
    plain = SandboxRunner("off")
    started: list[float] = []

    class SleepingRunner:
        def run(self, argv: list[str], **kwargs: Any) -> RunResult:
            started.append(time.monotonic())
            return plain.run(["sleep", "30"], **kwargs)

    ctx = make_context(make_config())
    ctx.deadline = TaskDeadline(
        base_ms=500, per_audio_permille=0, max_duration_ms=1, clock=time.monotonic
    )
    ctx.cancel.attach_deadline(ctx.deadline)
    handler_ = preprocess_handler(env.root, SleepingRunner())
    # The native pass is the first runner call; give it a real timeout far beyond the deadline.
    begun = time.monotonic()
    with pytest.raises(TaskFailure) as raised:
        handler_(ctx)
    assert time.monotonic() - begun < 10  # the 30 s sleep was cut at the deadline
    assert raised.value.code is ErrorCode.CANCELLED  # the executor maps expiry to TIMEOUT
    assert ctx.cancel.expired and not ctx.cancel.requested
    assert temp_dirs(env.root) == []
    assert started


# -- 3. `required` means enforced ------------------------------------------------------------------


class _DummyRuleset:
    def restrict_self(self) -> None: ...

    def close(self) -> None: ...


@pytest.fixture
def pretend_landlock(monkeypatch: pytest.MonkeyPatch) -> None:
    """A kernel that 'has' Landlock ABI 4 for the runner's decisions; no real confinement."""
    monkeypatch.setattr(runner_module, "probe_abi", lambda: 4)
    monkeypatch.setattr(runner_module, "build_ruleset", lambda abi, _paths: _DummyRuleset())


def test_required_refuses_children_until_the_self_test_has_passed(
    pretend_landlock: None, tmp_path: Path
) -> None:
    runner = SandboxRunner("required")
    marker = tmp_path / "ran"
    out = bytearray()
    with pytest.raises(SandboxError):  # a ruleset exists, but nothing has verified it
        runner.run(["touch", str(marker)], stdout_sink=out.extend, timeout_s=5)
    assert not marker.exists() and runner.landlock_enforced is False


def test_required_stays_refusing_when_the_self_test_fails(
    pretend_landlock: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = SandboxRunner("required")
    monkeypatch.setattr(SandboxRunner, "_canary_denied", lambda self: False)
    assert runner.verify_enforcement() is False
    marker = tmp_path / "ran"
    with pytest.raises(SandboxError):
        runner.run(["touch", str(marker)], stdout_sink=lambda _d: None, timeout_s=5)
    assert not marker.exists()


def test_required_runs_children_once_every_control_was_observed(
    pretend_landlock: None, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    runner = SandboxRunner("required")
    monkeypatch.setattr(SandboxRunner, "_canary_denied", lambda self: True)
    monkeypatch.setattr(SandboxRunner, "_tcp_denied", lambda self, python: True)
    monkeypatch.setattr(runner_module, "_selftest_python", lambda: "/usr/bin/python3")
    assert runner.verify_enforcement() is True and runner.landlock_enforced
    assert runner.landlock_scoped is False  # ABI 4: scoping does not exist
    marker = tmp_path / "ran"
    runner.run(["touch", str(marker)], stdout_sink=lambda _d: None, timeout_s=5)
    assert marker.exists()


def test_a_control_that_cannot_be_checked_is_not_enforcement(
    pretend_landlock: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ABI >= 4 needs the TCP check, which needs an interpreter a child may execute."""
    runner = SandboxRunner("auto")
    monkeypatch.setattr(SandboxRunner, "_canary_denied", lambda self: True)
    monkeypatch.setattr(runner_module, "_selftest_python", lambda: None)
    assert runner.verify_enforcement() is False and runner.landlock_enforced is False


def test_abi_6_requires_the_scoping_checks_and_reports_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runner_module, "probe_abi", lambda: 6)
    monkeypatch.setattr(runner_module, "build_ruleset", lambda abi, _paths: _DummyRuleset())
    monkeypatch.setattr(runner_module, "_selftest_python", lambda: "/usr/bin/python3")
    monkeypatch.setattr(SandboxRunner, "_canary_denied", lambda self: True)
    monkeypatch.setattr(SandboxRunner, "_tcp_denied", lambda self, python: True)
    monkeypatch.setattr(SandboxRunner, "_socket_denied", lambda self, python: True)
    runner = SandboxRunner("auto")
    monkeypatch.setattr(SandboxRunner, "_signal_denied", lambda self, python: False)
    assert runner.verify_enforcement() is False and runner.landlock_scoped is False
    monkeypatch.setattr(SandboxRunner, "_signal_denied", lambda self, python: True)
    assert runner.verify_enforcement() is True and runner.landlock_scoped is True


def test_the_ruleset_asks_for_scoping_only_on_abi_6() -> None:
    from audio_service.domain.landlock import scope_mask

    assert [scope_mask(a) for a in (1, 4, 5)] == [0, 0, 0]
    assert scope_mask(6) == 0b11  # abstract UNIX sockets and signals


# -- 6. rmtree is relative to an opened directory, never a path resolved again --------------------

REFS = TaskRefs(UUID(WS), UUID(REC))
PREFIX = f"derived/{WS}/{REC}/{CONFIG_HASH}"


@pytest.fixture
def storage_root(tmp_path: Path) -> Path:
    root = tmp_path / "storage"
    (root / "derived").mkdir(parents=True)
    return root


def make_victim(tmp_path: Path, task_id: UUID) -> Path:
    """What an attacker wants deleted: `<victim>/<hash>/.tmp-<id>/precious`."""
    victim = tmp_path / "victim"
    target = victim / CONFIG_HASH / f".tmp-{task_id}"
    target.mkdir(parents=True)
    (target / "precious").write_text("do not delete")
    return victim


def swap_for_symlink(directory: Path, to: Path) -> Path:
    """Replace `directory` with a symlink to `to`; the real directory moves aside."""
    aside = directory.with_name(directory.name + ".real")
    directory.rename(aside)
    directory.symlink_to(to)
    return aside


class SwappingBackend(LocalStorageBackend):
    """Swaps an intermediate component for a symlink right after the directory was opened."""

    def __init__(self, root: Path, swap: Callable[[], None]) -> None:
        super().__init__(root)
        self._swap = swap
        self._armed = True

    def _walk(self, parts: list[str], *, create: bool = False) -> int:
        fd = super()._walk(parts, create=create)
        if self._armed and create:
            self._armed = False
            self._swap()
        return fd


def test_begin_output_never_deletes_through_a_symlink_swapped_into_the_path(
    storage_root: Path, tmp_path: Path
) -> None:
    task_id = uuid4()
    victim = make_victim(tmp_path, task_id)
    recording_dir = storage_root / "derived" / WS / REC
    backend = SwappingBackend(storage_root, lambda: swap_for_symlink(recording_dir, victim))
    session = backend.begin_output(PREFIX, REFS, task_id)
    session.close()
    assert (victim / CONFIG_HASH / f".tmp-{task_id}" / "precious").read_text() == "do not delete"


def test_closing_a_session_never_deletes_through_a_swapped_path(
    storage_root: Path, tmp_path: Path
) -> None:
    task_id = uuid4()
    victim = make_victim(tmp_path, task_id)
    backend = LocalStorageBackend(storage_root)
    session = backend.begin_output(PREFIX, REFS, task_id)
    session.create_file("canonical.wav").write(b"partial")
    aside = swap_for_symlink(storage_root / "derived" / WS / REC, victim)
    session.close()  # a failed task: temp is discarded
    assert (victim / CONFIG_HASH / f".tmp-{task_id}" / "precious").read_text() == "do not delete"
    assert not (aside / CONFIG_HASH / f".tmp-{task_id}").exists()  # the real temp dir did go


def test_every_recursive_delete_in_storage_is_relative_to_a_descriptor(
    storage_root: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[tuple[str, int | None]] = []
    real = shutil.rmtree

    def spy(path: Any, *args: Any, **kwargs: Any) -> Any:
        calls.append((str(path), kwargs.get("dir_fd")))
        return real(path, *args, **kwargs)

    monkeypatch.setattr("audio_service.domain.storage.shutil.rmtree", spy)
    backend = LocalStorageBackend(storage_root)
    task_id = uuid4()
    stale = storage_root / "derived" / WS / REC / CONFIG_HASH / ".tmp-stale"
    stale.mkdir(parents=True)
    assert backend.cleanup_stale_temp() == 1
    session = backend.begin_output(PREFIX, REFS, task_id)
    session.close()
    backend.begin_output(PREFIX, REFS, task_id).publish()
    backend.delete_prefix(PREFIX, REFS)
    assert len(calls) >= 4
    for path, dir_fd in calls:
        assert dir_fd is not None and os.sep not in path, (path, dir_fd)


def test_stale_cleanup_does_not_follow_a_symlinked_level(
    storage_root: Path, tmp_path: Path
) -> None:
    victim = make_victim(tmp_path, UUID(int=1))
    (storage_root / "derived" / WS).symlink_to(victim.parent / "victim" / CONFIG_HASH / "..")
    LocalStorageBackend(storage_root).cleanup_stale_temp()
    assert (victim / CONFIG_HASH / f".tmp-{UUID(int=1)}" / "precious").exists()


def test_the_service_wires_the_deadline_settings_into_the_executor(
    settings: Any, auth: dict[str, str]
) -> None:
    """HTTP: a running task shows `deadlineAt`; past it the task fails TIMEOUT (retryable)."""
    from fastapi.testclient import TestClient

    from audio_service.api.app import create_app

    def handler(ctx: TaskContext) -> dict[str, Any]:
        ctx.set_audio_duration_ms(0)
        while True:
            ctx.check_cancelled()
            time.sleep(0.005)

    short = settings.model_copy(
        update={"task_deadline_base_ms": 1_000, "task_deadline_per_audio_ms_permille": 0}
    )
    app = create_app(short, {"probe": handler})
    with TestClient(app, raise_server_exceptions=False, headers=auth) as client:
        accepted = client.post("/v1/tasks", json=probe_body()).json()
        url = f"/v1/tasks/{accepted['taskId']}"
        first = client.get(url).json()
        assert first["status"] in ("queued", "running")
        wait_for(lambda: client.get(url).json()["status"] == "failed", timeout=10)
        state = client.get(url).json()
        assert state["error"] == {"code": "TIMEOUT", "retryable": True}
        assert state["deadlineAt"] is not None
        assert abs(state["deadlineAt"] - (time.time() + 0) * 1000) < 15_000


def probe_body() -> dict[str, Any]:
    from helpers import task_body

    return task_body()
