"""Landlock filesystem, TCP and scoping confinement for FFmpeg children (plan §6.2).

Implemented with ctypes syscalls (no dependency). Nothing here is assumed to work: `probe_abi`
asks the running kernel, and the capability report states whether a self-test child was actually
confined (see `runner.SandboxRunner.verify_enforcement`). The ruleset is built once in the parent;
the child only calls `prctl(PR_SET_NO_NEW_PRIVS)` and `landlock_restrict_self`, which keeps the
pre-exec step minimal.
"""

from __future__ import annotations

import ctypes
import os
import sys
from dataclasses import dataclass

_SYS_CREATE_RULESET = 444
_SYS_ADD_RULE = 445
_SYS_RESTRICT_SELF = 446
_CREATE_RULESET_VERSION = 1
_RULE_PATH_BENEATH = 1
_PR_SET_NO_NEW_PRIVS = 38
_PR_SET_DUMPABLE = 4
_O_PATH = getattr(os, "O_PATH", 0o10000000)  # Linux value; absent from os on macOS

# Filesystem access rights (include/uapi/linux/landlock.h) and the ABI that introduced them.
_FS_EXECUTE = 1 << 0
_FS_READ_FILE = 1 << 2
_FS_READ_DIR = 1 << 3
_FS_BITS_V1 = (1 << 13) - 1  # execute .. make_sym
_FS_REFER = 1 << 13  # ABI 2
_FS_TRUNCATE = 1 << 14  # ABI 3
_FS_IOCTL_DEV = 1 << 15  # ABI 5
_NET_BIND_TCP = 1 << 0  # ABI 4
_NET_CONNECT_TCP = 1 << 1
_SCOPE_ABSTRACT_UNIX_SOCKET = 1 << 0  # ABI 6: no connecting to abstract sockets outside the domain
_SCOPE_SIGNAL = 1 << 1  # ABI 6: no signalling processes outside the domain (the parent included)

# Read + execute is all FFmpeg needs from the filesystem: input arrives as an inherited descriptor
# and output goes to a pipe. /dev/null, /proc, /sys, /tmp, /storage and /app are not allowed.
DEFAULT_READ_EXEC_PATHS = ("/usr", "/lib", "/lib64", "/etc")


class _RulesetAttr(ctypes.Structure):
    _fields_ = [
        ("handled_access_fs", ctypes.c_uint64),
        ("handled_access_net", ctypes.c_uint64),
        ("scoped", ctypes.c_uint64),  # ABI 6
    ]


class _PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


def _libc() -> ctypes.CDLL | None:
    if not sys.platform.startswith("linux"):
        return None
    return ctypes.CDLL(None, use_errno=True)


def probe_abi() -> int | None:
    """Landlock ABI version of the running kernel, or None if unavailable (also under seccomp)."""
    libc = _libc()
    if libc is None:
        return None
    result = libc.syscall(_SYS_CREATE_RULESET, None, 0, _CREATE_RULESET_VERSION)
    return int(result) if result > 0 else None


def disable_dumping() -> bool:
    """`prctl(PR_SET_DUMPABLE, 0)` on this process: another process of the same user (a child that
    escaped its Landlock domain) can then no longer read `/proc/<pid>/environ` (the service token)
    or `/proc/<pid>/mem`, and the process cannot be core-dumped. Returns whether it was applied."""
    libc = _libc()
    return libc is not None and libc.prctl(_PR_SET_DUMPABLE, 0, 0, 0, 0) == 0


def scope_mask(abi: int) -> int:
    return (_SCOPE_ABSTRACT_UNIX_SOCKET | _SCOPE_SIGNAL) if abi >= 6 else 0


def handled_fs_mask(abi: int) -> int:
    mask = _FS_BITS_V1
    if abi >= 2:
        mask |= _FS_REFER
    if abi >= 3:
        mask |= _FS_TRUNCATE
    if abi >= 5:
        mask |= _FS_IOCTL_DEV
    return mask


@dataclass
class Ruleset:
    """A ready ruleset. `restrict_self` is called in the child between fork and exec."""

    fd: int
    abi: int
    scoped: bool
    _syscall: object
    _prctl: object

    def restrict_self(self) -> None:
        # Only pre-bound ctypes callables and integers are used: no imports, logging or
        # allocation-heavy code between fork and exec.
        if self._prctl(_PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:  # type: ignore[operator]
            raise OSError("no_new_privs failed")
        if self._syscall(_SYS_RESTRICT_SELF, self.fd, 0) != 0:  # type: ignore[operator]
            raise OSError("landlock_restrict_self failed")

    def close(self) -> None:
        os.close(self.fd)


def build_ruleset(abi: int, read_exec_paths: tuple[str, ...] = DEFAULT_READ_EXEC_PATHS) -> Ruleset:
    libc = _libc()
    if libc is None:
        raise OSError("landlock requires linux")
    handled = handled_fs_mask(abi)
    attr = _RulesetAttr(
        handled, (_NET_BIND_TCP | _NET_CONNECT_TCP) if abi >= 4 else 0, scope_mask(abi)
    )
    # The kernel accepts the struct sizes of its own ABI generation (and larger, zero-filled).
    size = 8 if abi < 4 else 16 if abi < 6 else ctypes.sizeof(attr)
    ruleset_fd = int(libc.syscall(_SYS_CREATE_RULESET, ctypes.byref(attr), size, 0))
    if ruleset_fd < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset failed")
    allowed = _FS_EXECUTE | _FS_READ_FILE | _FS_READ_DIR
    try:
        for path in read_exec_paths:
            if not os.path.isdir(path) or os.path.islink(path):
                continue  # e.g. /lib64 absent, or /lib a symlink into /usr (already allowed)
            parent_fd = os.open(path, _O_PATH | os.O_DIRECTORY | os.O_CLOEXEC)
            try:
                rule = _PathBeneath(allowed, parent_fd)
                if libc.syscall(
                    _SYS_ADD_RULE, ruleset_fd, _RULE_PATH_BENEATH, ctypes.byref(rule), 0
                ):
                    raise OSError(ctypes.get_errno(), "landlock_add_rule failed")
            finally:
                os.close(parent_fd)
    except BaseException:
        os.close(ruleset_fd)
        raise
    return Ruleset(
        fd=ruleset_fd, abi=abi, scoped=abi >= 6, _syscall=libc.syscall, _prctl=libc.prctl
    )
