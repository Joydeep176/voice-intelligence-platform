"""Storage backend interface and the local-filesystem implementation (plan §5).

Security properties (each has a test):
- only keys accepted by `storage_keys` are used; the key's workspace and recording segments must
  equal the task's;
- every path component is opened with O_NOFOLLOW relative to a directory descriptor, so a symlink
  anywhere below the root cannot redirect a read or write; a resolved-prefix check runs first;
- originals are opened read-only and must be regular files;
- outputs are written to `<prefix>/.tmp-<taskId>/` (disk, never tmpfs), fsynced, renamed into place,
  and `manifest.json` (SHA-256 of every file) is renamed last as the completion marker;
- files are created 0600 and directories 0700;
- temporary directories are deleted with `shutil.rmtree(name, dir_fd=<parent descriptor>)`, never by
  a path that is resolved again at deletion time, so a symlink swapped into any component after the
  directory was opened cannot redirect the deletion.
"""

from __future__ import annotations

import errno
import hashlib
import json
import os
import re
import shutil
import stat
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import IO, Any, Self
from uuid import UUID

from audio_service.contracts import ErrorCode
from audio_service.domain.errors import TaskFailure
from audio_service.domain.storage_keys import (
    TaskRefs,
    validate_original_key,
    validate_output_prefix,
)

MANIFEST_NAME = "manifest.json"
_OUTPUT_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_TMP_PREFIX = ".tmp-"
_MANIFEST_MAX_BYTES = 1 << 20


class OutputSession(ABC):
    """Collects the files of one task and publishes them atomically."""

    @abstractmethod
    def create_file(self, name: str) -> IO[bytes]: ...

    @abstractmethod
    def digest(self, name: str) -> tuple[str, int]:
        """(SHA-256, size) of a file created in this session, as it is now (flushes it first)."""

    @abstractmethod
    def publish(self) -> dict[str, Any]: ...

    @abstractmethod
    def close(self) -> None:
        """Discard anything unpublished. Always safe to call, also after `publish`."""

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class StorageBackend(ABC):
    @abstractmethod
    def open_original(self, key: str, refs: TaskRefs) -> int:
        """Return a read-only descriptor for this task's original. Caller closes it."""

    @abstractmethod
    def begin_output(self, prefix: str, refs: TaskRefs, task_id: UUID) -> OutputSession: ...

    @abstractmethod
    def is_published(self, prefix: str, refs: TaskRefs) -> bool:
        """True when the completion marker (`manifest.json`) exists under the prefix."""

    @abstractmethod
    def read_verified(
        self,
        prefix: str,
        refs: TaskRefs,
        name: str,
        *,
        expected_names: frozenset[str],
        max_bytes: int,
    ) -> bytes | None:
        """Bytes of `name` from a published prefix, only if the manifest lists exactly
        `expected_names` and every listed file matches its recorded SHA-256 and size. Any missing
        or damaged output returns None (the caller recomputes); nothing raises for it."""

    @abstractmethod
    def open_published_file(self, prefix: str, refs: TaskRefs, name: str) -> PublishedFile:
        """Open `name` from a published prefix for streaming reads (files too large for
        `read_verified`). The manifest must list it and the size must match; the recorded SHA-256
        is returned for the caller to verify when it streams the whole file. Raises `TaskFailure`
        (STORAGE_ERROR) when the output is missing, unlisted or damaged."""

    @abstractmethod
    def delete_prefix(self, prefix: str, refs: TaskRefs) -> None: ...

    @abstractmethod
    def ensure_free_space(self, required_bytes: int) -> None: ...

    @abstractmethod
    def cleanup_stale_temp(self) -> int:
        """Remove stale `.tmp-*` directories under `derived/` only. Returns how many."""


def _map_os_error(error: OSError) -> TaskFailure:
    if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR, errno.EXDEV):
        return TaskFailure(ErrorCode.INVALID_STORAGE_KEY)
    if error.errno in (errno.ENOSPC, errno.EDQUOT, errno.EFBIG):
        return TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)
    return TaskFailure(ErrorCode.STORAGE_ERROR)  # never expose the underlying path


def storage_failure(error: OSError) -> TaskFailure:
    """Map an `OSError` raised while writing task output to its task failure (no paths)."""
    return _map_os_error(error)


class LocalStorageBackend(StorageBackend):
    def __init__(self, root: Path) -> None:
        self._root = root.resolve()

    # -- helpers -------------------------------------------------------------------------------

    def _assert_beneath(self, parts: list[str]) -> None:
        resolved = Path(os.path.realpath(self._root.joinpath(*parts)))
        if resolved != self._root and self._root not in resolved.parents:
            raise TaskFailure(ErrorCode.INVALID_STORAGE_KEY)

    def _walk(self, parts: list[str], *, create: bool = False) -> int:
        """Open the directory `parts` below the root without following any symlink."""
        try:
            fd = os.open(self._root, _DIR_FLAGS)
        except OSError as error:
            raise _map_os_error(error) from None
        try:
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                nxt = os.open(part, _DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = nxt
            return fd
        except OSError as error:
            os.close(fd)
            raise _map_os_error(error) from None

    # -- reads ---------------------------------------------------------------------------------

    def open_original(self, key: str, refs: TaskRefs) -> int:
        parts = validate_original_key(key, refs)
        self._assert_beneath(parts)
        dir_fd = self._walk(parts[:-1])
        try:
            # O_NONBLOCK only prevents blocking on a FIFO planted in place of the file; it has no
            # effect on regular files, and non-regular files are rejected below.
            fd = os.open(
                parts[-1],
                os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK,
                dir_fd=dir_fd,
            )
        except OSError as error:
            raise _map_os_error(error) from None
        finally:
            os.close(dir_fd)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise TaskFailure(ErrorCode.INVALID_STORAGE_KEY)
        return fd

    def is_published(self, prefix: str, refs: TaskRefs) -> bool:
        parts = validate_output_prefix(prefix, refs)
        self._assert_beneath(parts)
        try:
            dir_fd = self._walk(parts)
        except TaskFailure:
            return False
        try:
            return stat.S_ISREG(
                os.stat(MANIFEST_NAME, dir_fd=dir_fd, follow_symlinks=False).st_mode
            )
        except OSError:
            return False
        finally:
            os.close(dir_fd)

    # -- writes --------------------------------------------------------------------------------

    def begin_output(self, prefix: str, refs: TaskRefs, task_id: UUID) -> OutputSession:
        parts = validate_output_prefix(prefix, refs)
        self._assert_beneath(parts)
        out_fd = self._walk(parts, create=True)
        tmp_name = f"{_TMP_PREFIX}{task_id}"
        try:
            shutil.rmtree(tmp_name, dir_fd=out_fd, ignore_errors=True)  # a stale one, by descriptor
            os.mkdir(tmp_name, 0o700, dir_fd=out_fd)
            tmp_fd = os.open(tmp_name, _DIR_FLAGS, dir_fd=out_fd)
        except OSError as error:
            os.close(out_fd)
            raise _map_os_error(error) from None
        return _LocalOutputSession(out_fd, tmp_fd, tmp_name)

    def read_verified(
        self,
        prefix: str,
        refs: TaskRefs,
        name: str,
        *,
        expected_names: frozenset[str],
        max_bytes: int,
    ) -> bytes | None:
        parts = validate_output_prefix(prefix, refs)
        self._assert_beneath(parts)
        try:
            dir_fd = self._walk(parts)
        except TaskFailure:
            return None
        try:
            manifest = json.loads(_read_file(dir_fd, MANIFEST_NAME, _MANIFEST_MAX_BYTES).data)
            entries = {entry["name"]: entry for entry in manifest["files"]}
            if frozenset(entries) != expected_names or name not in entries:
                return None
            wanted: bytes | None = None
            for entry_name, entry in entries.items():
                keep = max_bytes if entry_name == name else 0
                read = _read_file(dir_fd, entry_name, keep)
                if read.sha256 != entry["sha256"] or read.size != entry["bytes"]:
                    return None
                if entry_name == name:
                    if read.size > max_bytes:
                        return None
                    wanted = read.data
            return wanted
        except (OSError, ValueError, KeyError, TypeError):
            return None
        finally:
            os.close(dir_fd)

    def open_published_file(self, prefix: str, refs: TaskRefs, name: str) -> PublishedFile:
        parts = validate_output_prefix(prefix, refs)
        self._assert_beneath(parts)
        if not _OUTPUT_NAME.fullmatch(name) or name == MANIFEST_NAME:
            raise TaskFailure(ErrorCode.INVALID_STORAGE_KEY)
        dir_fd = self._walk(parts)
        try:
            try:
                manifest = json.loads(_read_file(dir_fd, MANIFEST_NAME, _MANIFEST_MAX_BYTES).data)
                entry = next(e for e in manifest["files"] if e["name"] == name)
                expected_sha, expected_size = str(entry["sha256"]), int(entry["bytes"])
            except (OSError, ValueError, KeyError, TypeError, StopIteration):
                raise TaskFailure(ErrorCode.STORAGE_ERROR) from None
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
            except OSError:
                raise TaskFailure(ErrorCode.STORAGE_ERROR) from None
        finally:
            os.close(dir_fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected_size:
            os.close(fd)
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        return PublishedFile(fd=fd, sha256=expected_sha, size=expected_size)

    def delete_prefix(self, prefix: str, refs: TaskRefs) -> None:
        parts = validate_output_prefix(prefix, refs)
        self._assert_beneath(parts)
        parent_fd = self._walk(parts[:-1])
        try:
            shutil.rmtree(parts[-1], dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        except OSError as error:
            raise _map_os_error(error) from None
        finally:
            os.close(parent_fd)

    def ensure_free_space(self, required_bytes: int) -> None:
        target = self._root / "derived"
        try:
            usage = os.statvfs(target if target.exists() else self._root)
        except OSError as error:
            raise _map_os_error(error) from None
        if usage.f_bavail * usage.f_frsize < required_bytes:
            raise TaskFailure(ErrorCode.RESOURCE_LIMIT_EXCEEDED)

    def cleanup_stale_temp(self) -> int:
        """derived/<workspace>/<recording>/<configHash>/.tmp-*. Every level is opened relative to
        its parent's descriptor without following symlinks, and each temporary directory is removed
        relative to its parent's descriptor."""
        try:
            top = self._walk(["derived"])
        except TaskFailure:
            return 0
        try:
            return self._remove_stale(top, 3)
        finally:
            os.close(top)

    def _remove_stale(self, dir_fd: int, levels: int) -> int:
        removed = 0
        for name in _names(dir_fd):
            if levels == 0:
                if name.startswith(_TMP_PREFIX) and _is_dir(dir_fd, name):
                    shutil.rmtree(name, dir_fd=dir_fd, ignore_errors=True)
                    removed += 1
                continue
            if not _is_dir(dir_fd, name):
                continue
            try:
                child = os.open(name, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError:
                continue  # replaced by a symlink or removed since it was listed
            try:
                removed += self._remove_stale(child, levels - 1)
            finally:
                os.close(child)
        return removed


@dataclass(frozen=True)
class PublishedFile:
    """A read-only descriptor of a published output file and its manifest entry."""

    fd: int
    sha256: str
    size: int

    def verify_sha256(self) -> bool:
        """Stream the whole file from offset 0 and compare with the manifest's SHA-256."""
        sha = hashlib.sha256()
        offset = 0
        while chunk := os.pread(self.fd, 1 << 20, offset):
            sha.update(chunk)
            offset += len(chunk)
        return offset == self.size and sha.hexdigest() == self.sha256

    def close(self) -> None:
        os.close(self.fd)


@dataclass(frozen=True)
class _FileRead:
    sha256: str
    size: int
    data: bytes  # kept only up to the requested limit


def _read_file(dir_fd: int, name: str, keep_bytes: int) -> _FileRead:
    """Stream a regular file below `dir_fd` (never following a symlink), keeping at most
    `keep_bytes` of it; raises `ValueError` when the manifest itself is oversized."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        sha, size, kept = hashlib.sha256(), 0, bytearray()
        while chunk := os.read(fd, 1 << 20):
            sha.update(chunk)
            size += len(chunk)
            if size <= keep_bytes:
                kept += chunk
        if name == MANIFEST_NAME and size > _MANIFEST_MAX_BYTES:
            raise ValueError("manifest too large")
        return _FileRead(sha.hexdigest(), size, bytes(kept))
    finally:
        os.close(fd)


def _names(dir_fd: int) -> list[str]:
    try:
        with os.scandir(dir_fd) as it:
            return sorted(entry.name for entry in it)
    except OSError:
        return []


def _is_dir(dir_fd: int, name: str) -> bool:
    try:
        return stat.S_ISDIR(os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode)
    except OSError:
        return False


class _LocalOutputSession(OutputSession):
    def __init__(self, out_fd: int, tmp_fd: int, tmp_name: str) -> None:
        self._out_fd = out_fd
        self._tmp_fd = tmp_fd
        self._tmp_name = tmp_name
        self._names: list[str] = []
        self._open_files: list[IO[bytes]] = []
        self._closed = False

    def create_file(self, name: str) -> IO[bytes]:
        if not _OUTPUT_NAME.fullmatch(name) or name == MANIFEST_NAME or name in self._names:
            raise TaskFailure(ErrorCode.INVALID_STORAGE_KEY)
        try:
            fd = os.open(
                name,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=self._tmp_fd,
            )
        except OSError as error:
            raise _map_os_error(error) from None
        self._names.append(name)
        handle = os.fdopen(fd, "wb")
        self._open_files.append(handle)
        return handle

    def digest(self, name: str) -> tuple[str, int]:
        if name not in self._names or self._closed:
            raise TaskFailure(ErrorCode.INTERNAL_ERROR)
        try:
            for handle in self._open_files:
                if not handle.closed:
                    handle.flush()
            return self._digest(name)
        except OSError as error:
            raise _map_os_error(error) from None

    def _digest(self, name: str) -> tuple[str, int]:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self._tmp_fd)
        try:
            os.fsync(fd)
            sha, size = hashlib.sha256(), 0
            while chunk := os.read(fd, 1 << 20):
                sha.update(chunk)
                size += len(chunk)
            return sha.hexdigest(), size
        finally:
            os.close(fd)

    def publish(self) -> dict[str, Any]:
        if self._closed:
            raise TaskFailure(ErrorCode.INTERNAL_ERROR)
        try:
            for handle in self._open_files:
                handle.close()  # flushes; a failed flush raises OSError
            files = []
            for name in sorted(self._names):
                sha256, size = self._digest(name)
                files.append({"name": name, "sha256": sha256, "bytes": size})
            manifest = {"files": files}
            payload = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
            fd = os.open(
                MANIFEST_NAME,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
                dir_fd=self._tmp_fd,
            )
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.fsync(self._tmp_fd)
            # A previous manifest is removed first, so a missing manifest always means "incomplete".
            try:
                os.unlink(MANIFEST_NAME, dir_fd=self._out_fd)
            except FileNotFoundError:
                pass
            for name in [*sorted(self._names), MANIFEST_NAME]:  # manifest last
                os.rename(name, name, src_dir_fd=self._tmp_fd, dst_dir_fd=self._out_fd)
            os.fsync(self._out_fd)
            return manifest
        except OSError as error:
            raise _map_os_error(error) from None
        finally:
            self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for handle in self._open_files:
            try:
                handle.close()
            except OSError:
                pass
        shutil.rmtree(self._tmp_name, dir_fd=self._out_fd, ignore_errors=True)
        os.close(self._tmp_fd)
        os.close(self._out_fd)
