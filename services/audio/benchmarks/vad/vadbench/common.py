"""Constants shared by every stage. Benchmark settings, NOT approved segmentation limits."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

SAMPLE_RATE = 16_000
FRAME = 160  # 10 ms reference frame in samples
FRAME_S = 0.01

# Chunk length for streaming: a multiple of every candidate frame (Silero 512, WebRTC 160/320/480).
CHUNK_SAMPLES = 15_360 * 31  # 29.76 s

CORPUS_SEED = 20_261_121
SNRS = ["clean", 20, 10, 5, 0]
NOISE_TYPES = ["white", "pink", "brown", "hum", "am_pink", "clicks", "music"]
STATIONARY = {"white", "pink", "brown", "hum"}
LANGUAGES = ["english", "hindi", "hinglish"]
SPLITS = ["dev", "test"]
DEV_PER_LANGUAGE = 12
UTTERANCES_PER_SCENE = 12
SCENES = {"dev": 1, "test": 4}
GAP_RANGE_S = (0.2, 5.0)
CLEAN_FLOOR_DBFS = -70.0

# Reference-label rule (see README, "Reference labels").
REF_REL_DB = 40.0
REF_FILL_FRAMES = 10
REF_MIN_SPEECH_FRAMES = 3
UTTERANCE_MARGIN_FRAMES = 5

# Post-processing shared by all candidates (benchmark settings, not approved limits).
MIN_SPEECH_FRAMES = 25
MIN_SILENCE_FRAMES = 30
PAD_FRAMES = 20

# Plan section 13.4 numbers.
RTF_LIMIT = 0.05
MEMORY_GATE_MB = 384


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))
