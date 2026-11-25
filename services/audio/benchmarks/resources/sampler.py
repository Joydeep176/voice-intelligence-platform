"""Resource sampler sidecar (Phase 2B WS9a). Stdlib only; read-only.

Runs in a SEPARATE container that shares the audio container's PID namespace (`--pid container:`)
and the host cgroup namespace, with /sys/fs/cgroup mounted read-only, so that sampling never adds a
process or memory to the measured container's cgroup. Prints one JSON line per sample (10 Hz):
cgroup memory.current / anon / file, cpu usage, pids, FFmpeg child RSS, temp-dir bytes.

The current case label is read from /out/case (written by the host driver).
"""

from __future__ import annotations

import json
import os
import sys
import time

INTERVAL = 0.1


def find_cgroup() -> str:
    for pid in sorted((p for p in os.listdir("/proc") if p.isdigit()), key=int):
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
            if "audio-service" in cmd or "audio_service" in cmd:
                with open(f"/proc/{pid}/cgroup") as f:
                    line = f.read().strip().splitlines()[0]
                return "/cg" + line.split("::", 1)[1]
        except OSError:
            continue
    raise SystemExit("audio service process not visible")


def read_kv(path: str) -> dict[str, int]:
    out: dict[str, int] = {}
    with open(path) as f:
        for line in f:
            k, _, v = line.partition(" ")
            if v.strip().lstrip("-").isdigit():
                out[k] = int(v)
    return out


def read_int(path: str) -> int | None:
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def tmp_bytes(root: str) -> int:
    total = 0
    try:
        for ws in os.scandir(root):
            for rec in os.scandir(ws.path):
                for cfg in os.scandir(rec.path):
                    for e in os.scandir(cfg.path):
                        if e.name.startswith(".tmp-") and e.is_dir(follow_symlinks=False):
                            for f in os.scandir(e.path):
                                try:
                                    total += f.stat(follow_symlinks=False).st_size
                                except OSError:
                                    pass
    except OSError:
        pass
    return total


def ffmpeg_children() -> tuple[int, int, int]:
    """(count, sum of VmRSS kB, max VmHWM kB) over ffmpeg/ffprobe processes."""
    n = rss = hwm = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/comm") as f:
                comm = f.read().strip()
            if comm not in ("ffmpeg", "ffprobe"):
                continue
            with open(f"/proc/{pid}/status") as f:
                st = f.read()
        except OSError:
            continue
        n += 1
        for line in st.splitlines():
            if line.startswith("VmRSS:"):
                rss += int(line.split()[1])
            elif line.startswith("VmHWM:"):
                hwm = max(hwm, int(line.split()[1]))
    return n, rss, hwm


def main() -> None:
    cg = find_cgroup()
    print(json.dumps({"event": "ready", "cgroup": cg.removeprefix("/cg")}), flush=True)  # noqa: T201 - JSON-lines output read by run.mjs
    while True:
        started = time.monotonic()
        try:
            with open("/out/case") as f:
                case = f.read().strip()
        except OSError:
            case = ""
        stat = read_kv(f"{cg}/memory.stat")
        cpu = read_kv(f"{cg}/cpu.stat")
        n, rss, hwm = ffmpeg_children()
        print(  # noqa: T201 - JSON-lines output read by run.mjs
            json.dumps(
                {
                    "t": round(time.time(), 3),
                    "case": case,
                    "current": read_int(f"{cg}/memory.current"),
                    "peak": read_int(f"{cg}/memory.peak"),
                    "anon": stat.get("anon"),
                    "file": stat.get("file"),
                    "shmem": stat.get("shmem"),
                    "cpuUsec": cpu.get("usage_usec"),
                    "throttledUsec": cpu.get("throttled_usec"),
                    "pids": read_int(f"{cg}/pids.current"),
                    "ffN": n,
                    "ffRssKb": rss,
                    "ffHwmKb": hwm,
                    "tmpBytes": tmp_bytes("/data/derived"),
                }
            ),
            flush=True,
        )
        time.sleep(max(0.0, INTERVAL - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
