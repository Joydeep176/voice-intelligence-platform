"""Local storage backend (plan §5). Every test fails if the matching control is removed."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from helpers import CONFIG_HASH, OTHER_WS, REC, WS

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.storage import LocalStorageBackend
from audio_service.domain.storage_keys import TaskRefs

REFS = TaskRefs(UUID(WS), UUID(REC))
ORIGINAL = f"recordings/{WS}/{REC}/original"
PREFIX = f"derived/{WS}/{REC}/{CONFIG_HASH}"


@pytest.fixture
def root(tmp_path: Path) -> Path:
    base = tmp_path / "storage"
    (base / "recordings" / WS / REC).mkdir(parents=True)
    (base / "recordings" / WS / REC / "original").write_bytes(b"original-bytes")
    (base / "derived").mkdir()
    return base


@pytest.fixture
def backend(root: Path) -> LocalStorageBackend:
    return LocalStorageBackend(root)


def code_of(call: object) -> ErrorCode:
    with pytest.raises(TaskFailure) as info:
        call()  # type: ignore[operator]
    return info.value.code


# -- reads --------------------------------------------------------------------------------------


def test_reads_the_tasks_original_read_only(backend: LocalStorageBackend) -> None:
    fd = backend.open_original(ORIGINAL, REFS)
    try:
        assert os.read(fd, 100) == b"original-bytes"
        with pytest.raises(OSError):  # the descriptor is read-only
            os.write(fd, b"x")
    finally:
        os.close(fd)


@pytest.mark.parametrize(
    "key",
    [
        f"recordings/{WS}/{REC}/../original",
        f"recordings/{WS}/{REC}/..%2foriginal",
        f"../recordings/{WS}/{REC}/original",
        f"/recordings/{WS}/{REC}/original",
        "/etc/passwd",
        f"recordings/{WS}/{REC}/original/",
        f"recordings//{WS}/{REC}/original",
        f"recordings/{WS}/{REC}/./original",
        f"recordings\\{WS}\\{REC}\\original",
        f"Recordings/{WS}/{REC}/original",
        f"recordings/{WS}/{REC}/original\x00",
        "recordings/" + "a" * 600,
        "",
    ],
)
def test_traversal_absolute_and_malformed_keys_are_rejected(
    backend: LocalStorageBackend, key: str
) -> None:
    assert code_of(lambda: backend.open_original(key, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_other_workspace_is_a_mismatch(backend: LocalStorageBackend) -> None:
    key = f"recordings/{OTHER_WS}/{REC}/original"
    assert code_of(lambda: backend.open_original(key, REFS)) is ErrorCode.WORKSPACE_MISMATCH


def test_other_recording_is_a_mismatch(backend: LocalStorageBackend) -> None:
    key = f"recordings/{WS}/{uuid4()}/original"
    assert code_of(lambda: backend.open_original(key, REFS)) is ErrorCode.WORKSPACE_MISMATCH


@pytest.mark.parametrize(
    "key",
    [
        f"recordings/{WS}/{REC}/other",
        f"recordings/{WS}/{REC}",
        f"derived/{WS}/{REC}/{CONFIG_HASH}",
        f"derived/{WS}/{REC}/{CONFIG_HASH}/manifest",
        f"uploads/{REC}/parts/000001",
        f"recordings/{WS}/{REC}/original/extra",
    ],
)
def test_only_the_original_key_is_readable(backend: LocalStorageBackend, key: str) -> None:
    assert code_of(lambda: backend.open_original(key, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_symlink_escaping_the_root_is_rejected(root: Path, backend: LocalStorageBackend) -> None:
    secret = root.parent / "outside-secret"
    secret.write_bytes(b"secret")
    original = root / "recordings" / WS / REC / "original"
    original.unlink()
    original.symlink_to(secret)
    assert code_of(lambda: backend.open_original(ORIGINAL, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_symlink_inside_the_root_is_also_rejected(root: Path, backend: LocalStorageBackend) -> None:
    other = root / "recordings" / WS / REC / "elsewhere"
    other.write_bytes(b"another file in the root")
    original = root / "recordings" / WS / REC / "original"
    original.unlink()
    original.symlink_to(other)
    assert code_of(lambda: backend.open_original(ORIGINAL, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_symlinked_directory_component_is_rejected(
    root: Path, backend: LocalStorageBackend
) -> None:
    outside = root.parent / "other-tree" / REC
    outside.mkdir(parents=True)
    (outside / "original").write_bytes(b"outside")
    (root / "recordings" / WS / REC / "original").unlink()
    (root / "recordings" / WS / REC).rmdir()
    (root / "recordings" / WS / REC).symlink_to(outside)
    assert code_of(lambda: backend.open_original(ORIGINAL, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_fifo_in_place_of_the_original_is_rejected_without_blocking(
    root: Path, backend: LocalStorageBackend
) -> None:
    original = root / "recordings" / WS / REC / "original"
    original.unlink()
    os.mkfifo(original)
    assert code_of(lambda: backend.open_original(ORIGINAL, REFS)) is ErrorCode.INVALID_STORAGE_KEY


def test_missing_original_is_a_storage_error(root: Path, backend: LocalStorageBackend) -> None:
    (root / "recordings" / WS / REC / "original").unlink()
    assert code_of(lambda: backend.open_original(ORIGINAL, REFS)) is ErrorCode.STORAGE_ERROR


# -- writes -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "prefix",
    [
        f"recordings/{WS}/{REC}/{CONFIG_HASH}",
        f"uploads/{WS}/{REC}/{CONFIG_HASH}",
        f"derived/{WS}/{REC}/short",
        f"derived/{WS}/{REC}/{'A' * 64}",
        f"derived/{WS}/{REC}",
        f"derived/{WS}/{REC}/{CONFIG_HASH}/sub",
        f"derived/{WS}/{REC}/../{CONFIG_HASH}",
        f"/derived/{WS}/{REC}/{CONFIG_HASH}",
        "derived",
    ],
)
def test_writes_are_only_allowed_under_derived_with_a_config_hash(
    backend: LocalStorageBackend, prefix: str
) -> None:
    assert (
        code_of(lambda: backend.begin_output(prefix, REFS, uuid4()))
        is ErrorCode.INVALID_STORAGE_KEY
    )


def test_writes_for_another_workspace_are_a_mismatch(backend: LocalStorageBackend) -> None:
    prefix = f"derived/{OTHER_WS}/{REC}/{CONFIG_HASH}"
    assert (
        code_of(lambda: backend.begin_output(prefix, REFS, uuid4())) is ErrorCode.WORKSPACE_MISMATCH
    )


def test_output_names_cannot_escape_or_overwrite_the_manifest(backend: LocalStorageBackend) -> None:
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        for name in ("../x", "a/b", "/abs", "manifest.json", ".hidden", "", "UPPER", "x" * 65):
            assert code_of(lambda n=name: session.create_file(n)) is ErrorCode.INVALID_STORAGE_KEY  # type: ignore[misc]
        session.create_file("a.bin")
        assert code_of(lambda: session.create_file("a.bin")) is ErrorCode.INVALID_STORAGE_KEY


def test_publish_is_atomic_with_manifest_hashes_modes_and_cleanup(
    root: Path, backend: LocalStorageBackend
) -> None:
    out = root / PREFIX
    task_id = uuid4()
    session = backend.begin_output(PREFIX, REFS, task_id)
    with session:
        with session.create_file("canonical.wav") as f:
            f.write(b"wav-bytes")
        with session.create_file("peaks.bin") as f:
            f.write(b"peaks")
        assert (out / f".tmp-{task_id}").is_dir()
        assert sorted(p.name for p in out.iterdir()) == [f".tmp-{task_id}"]  # nothing visible yet
        assert not backend.is_published(PREFIX, REFS)
        manifest = session.publish()
    assert sorted(p.name for p in out.iterdir()) == ["canonical.wav", "manifest.json", "peaks.bin"]
    assert backend.is_published(PREFIX, REFS)
    assert manifest == json.loads((out / "manifest.json").read_text())
    expected = {
        "canonical.wav": hashlib.sha256(b"wav-bytes").hexdigest(),
        "peaks.bin": hashlib.sha256(b"peaks").hexdigest(),
    }
    assert {f["name"]: f["sha256"] for f in manifest["files"]} == expected
    assert {f["name"]: f["bytes"] for f in manifest["files"]} == {
        "canonical.wav": 9,
        "peaks.bin": 5,
    }
    for path in out.iterdir():
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    for directory in (out, out.parent, out.parent.parent):
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700


def test_manifest_is_renamed_last(
    backend: LocalStorageBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    renamed: list[str] = []
    real = os.rename

    def spy(src: str, dst: str, **kwargs: object) -> None:
        renamed.append(dst)
        real(src, dst, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("audio_service.domain.storage.os.rename", spy)
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        for name in ("a.bin", "b.bin"):
            with session.create_file(name) as f:
                f.write(b"x")
        session.publish()
    assert renamed == ["a.bin", "b.bin", "manifest.json"]


def test_rerun_produces_identical_bytes(root: Path, backend: LocalStorageBackend) -> None:
    def run() -> bytes:
        with backend.begin_output(PREFIX, REFS, uuid4()) as session:
            with session.create_file("a.bin") as f:
                f.write(b"same")
            session.publish()
        return (root / PREFIX / "manifest.json").read_bytes() + (
            root / PREFIX / "a.bin"
        ).read_bytes()

    assert run() == run()


def test_unpublished_output_leaves_nothing_behind(root: Path, backend: LocalStorageBackend) -> None:
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        with session.create_file("a.bin") as f:
            f.write(b"x")
    assert list((root / PREFIX).iterdir()) == []
    assert not backend.is_published(PREFIX, REFS)


def test_failed_publish_never_exposes_a_manifest(
    root: Path, backend: LocalStorageBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}
    real = os.rename

    def flaky(src: str, dst: str, **kwargs: object) -> None:
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError(5, "boom")
        real(src, dst, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("audio_service.domain.storage.os.rename", flaky)
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        for name in ("a.bin", "b.bin"):
            with session.create_file(name) as f:
                f.write(b"x")
        assert code_of(session.publish) is ErrorCode.STORAGE_ERROR
    assert not backend.is_published(PREFIX, REFS)
    assert not any(p.name.startswith(".tmp-") for p in (root / PREFIX).iterdir())


def test_republish_removes_the_old_manifest_first(root: Path, backend: LocalStorageBackend) -> None:
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        session.create_file("a.bin").close()
        session.publish()
    assert backend.is_published(PREFIX, REFS)
    with backend.begin_output(PREFIX, REFS, uuid4()) as session:
        session.create_file("b.bin").close()
        session.publish()
    assert json.loads((root / PREFIX / "manifest.json").read_text())["files"][0]["name"] == "b.bin"


def test_stale_temp_directories_are_removed_under_derived_only(
    root: Path, backend: LocalStorageBackend
) -> None:
    stale = root / PREFIX / ".tmp-crashed-task"
    stale.mkdir(parents=True)
    (stale / "partial.bin").write_bytes(b"x")
    keep_published = root / PREFIX / "a.bin"
    keep_published.write_bytes(b"x")
    outside = root / "recordings" / WS / REC / ".tmp-not-ours"
    outside.mkdir()
    deeper = root / PREFIX / "nested" / ".tmp-too-deep"
    deeper.mkdir(parents=True)
    symlink_target = root.parent / "victim"
    symlink_target.mkdir()
    (root / PREFIX / ".tmp-link").symlink_to(symlink_target)

    assert backend.cleanup_stale_temp() == 1
    assert not stale.exists()
    assert keep_published.exists() and outside.exists() and deeper.exists()
    assert symlink_target.exists() and (root / PREFIX / ".tmp-link").is_symlink()


def test_free_space_precheck(backend: LocalStorageBackend) -> None:
    backend.ensure_free_space(1)
    assert code_of(lambda: backend.ensure_free_space(1 << 62)) is ErrorCode.RESOURCE_LIMIT_EXCEEDED


def test_delete_prefix_removes_only_that_prefix(root: Path, backend: LocalStorageBackend) -> None:
    other = f"derived/{WS}/{REC}/{'b' * 64}"
    for prefix in (PREFIX, other):
        with backend.begin_output(prefix, REFS, uuid4()) as session:
            session.create_file("a.bin").close()
            session.publish()
    backend.delete_prefix(PREFIX, REFS)
    assert not (root / PREFIX).exists() and (root / other / "manifest.json").exists()
    backend.delete_prefix(PREFIX, REFS)  # idempotent
    assert (root / "recordings" / WS / REC / "original").exists()
