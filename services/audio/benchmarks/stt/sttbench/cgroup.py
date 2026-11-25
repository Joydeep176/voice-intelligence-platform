"""cgroup v2 memory/CPU readings and a sampler for anonymous memory (container only)."""

from __future__ import annotations

import threading
import time
from pathlib import Path

CGROUP = Path("/sys/fs/cgroup")
MIB = 1024 * 1024


def read_int(name: str) -> int | None:
    try:
        return int((CGROUP / name).read_text().strip())
    except (OSError, ValueError):
        return None


def read_text(name: str) -> str | None:
    try:
        return (CGROUP / name).read_text().strip()
    except OSError:
        return None


def stat(key: str) -> int | None:
    try:
        for line in (CGROUP / "memory.stat").read_text().splitlines():
            k, _, v = line.partition(" ")
            if k == key:
                return int(v)
    except OSError:
        return None
    return None


class AnonSampler(threading.Thread):
    """Samples cgroup anonymous memory every 100 ms (a thread of the measured process)."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.samples: list[int] = []
        self._stop_event = threading.Event()

    def run(self) -> None:
        while not self._stop_event.is_set():
            self.samples.append(stat("anon") or 0)
            time.sleep(0.1)

    def stop(self) -> None:
        self._stop_event.set()
        self.join()

    def summary(self) -> dict[str, float]:
        s = self.samples or [0]
        third = max(1, len(s) // 3)
        return {
            "anon_max_mib": max(s) / MIB,
            "anon_first_third_max_mib": max(s[:third]) / MIB,
            "anon_last_third_max_mib": max(s[-third:]) / MIB,
        }
