"""Shared helpers for the Phase 2C STT and diarization benchmarks. Selects nothing (OD-02b)."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

SAMPLE_RATE = 16_000
SEED = 20_261_122
SNRS: list[Any] = ["clean", 20, 10, 5]
BENCH = Path(__file__).resolve().parents[2]  # .../benchmarks
MODELS_JSON = Path(__file__).resolve().parents[1] / "models.json"
LOCK_JSON = Path(__file__).resolve().parents[1] / "models.lock.json"

# The Phase 2B corpus code (sentences, noise generators, mixing) is reused, not copied.
sys.path.insert(0, str(BENCH / "vad"))


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n", "utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def verified_model_path(models_root: Path, model_id: str, name: str) -> Path:
    """Path to a pinned model file after checking its SHA-256 against models.lock.json."""
    spec = read_json(MODELS_JSON)["models"][model_id]
    path = models_root / spec["dir"] / name
    lock = read_json(LOCK_JSON)
    key = f"{spec['dir']}/{name}"
    if key not in lock:
        raise RuntimeError(f"{key} is not pinned in models.lock.json (run the fetch stage)")
    actual = sha256_file(path)
    if actual != lock[key]["sha256"]:
        raise RuntimeError(f"hash mismatch for {key}: refusing to load")
    return path
