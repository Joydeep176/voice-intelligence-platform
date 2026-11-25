"""Resource measurement for one candidate in a fresh container (cgroup v2 files)."""

from __future__ import annotations

import statistics
import threading
import time
from pathlib import Path
from typing import Any

from . import common as c
from . import detectors as d
from .evaluate import score_stream

CGROUP = Path("/sys/fs/cgroup")


def _read_int(name: str) -> int | None:
    try:
        return int((CGROUP / name).read_text().strip())
    except (OSError, ValueError):
        return None


def _stat(key: str) -> int | None:
    try:
        for line in (CGROUP / "memory.stat").read_text().splitlines():
            k, _, v = line.partition(" ")
            if k == key:
                return int(v)
    except OSError:
        return None
    return None


class AnonSampler(threading.Thread):
    """Samples cgroup anonymous memory every 50 ms (the sampler is a thread of the process)."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.max_anon = 0
        self.samples: list[int] = []
        self._stop_event = threading.Event()

    def run(self) -> None:
        while not self._stop_event.is_set():
            anon = _stat("anon") or 0
            self.max_anon = max(self.max_anon, anon)
            self.samples.append(anon)
            time.sleep(0.05)

    def stop(self) -> None:
        self._stop_event.set()
        self.join()


def measure(candidate: str, params: dict[str, Any], corpus: Path, models: Path) -> dict[str, Any]:
    wav = corpus / "long" / "long-60.wav"
    detector = d.make_detector(candidate, params, models)
    anon_before = _stat("anon")
    sampler = AnonSampler()
    sampler.start()
    runs = []
    for _ in range(3):
        wall0, cpu0 = time.perf_counter(), time.process_time()
        scores = score_stream(detector, wav)
        d.decide(candidate, scores, params)
        wall, cpu = time.perf_counter() - wall0, time.process_time() - cpu0
        frames = scores.shape[1]
        audio_s = frames * c.FRAME_S
        runs.append(
            {
                "wall_s": wall,
                "cpu_s": cpu,
                "audio_s": audio_s,
                "rtf": wall / audio_s,
                "cpu_s_per_audio_hour": cpu / (audio_s / 3600),
            }
        )
    sampler.stop()
    third = max(1, len(sampler.samples) // 3)
    mib = 1024 * 1024
    peak = _read_int("memory.peak")
    return {
        "candidate": candidate,
        "params": params,
        "audio_file": "long-60",
        "runs": runs,
        "rtf_median": statistics.median(r["rtf"] for r in runs),
        "cpu_s_per_audio_hour_median": statistics.median(r["cpu_s_per_audio_hour"] for r in runs),
        "memory_peak_mib": None if peak is None else peak / mib,
        "anon_before_mib": None if anon_before is None else anon_before / mib,
        "anon_max_sampled_mib": sampler.max_anon / mib,
        "anon_first_third_max_mib": max(sampler.samples[:third]) / mib,
        "anon_last_third_max_mib": max(sampler.samples[-third:]) / mib,
        "file_cache_final_mib": (_stat("file") or 0) / mib,
        "cgroup_memory_max": (CGROUP / "memory.max").read_text().strip()
        if (CGROUP / "memory.max").exists()
        else None,
        "cgroup_cpu_max": (CGROUP / "cpu.max").read_text().strip()
        if (CGROUP / "cpu.max").exists()
        else None,
    }
