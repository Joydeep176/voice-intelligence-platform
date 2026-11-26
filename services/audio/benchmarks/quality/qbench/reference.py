"""Ground truth from the Phase 2B VAD corpus: hash check, exact regeneration, achieved SNR.

The known mixing SNR is the reference (Phase 3A M0 methodology, A1_ALGORITHMS_AND_EVALUATION §6.1).
Every mixture is regenerated from its stored utterances and manifest seeds with the corpus's own
generator code; the regenerated int16 mixture must equal the stored WAV sample for sample, and only
then is the achieved SNR computed from the true components. Nothing is invented: a mixture that
fails a check carries the failure, not a value.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from vadbench import common as vc
from vadbench import corpus as vcorpus
from vadbench.noise import GENERATORS

Array = np.ndarray


@dataclass
class Components:
    clean: Array  # float64, scaled exactly as in the stored mixture
    noise: Array  # float64: stored mixture minus scaled clean (noise + quantisation)
    ref: Array  # reference speech frames (bool, 10 ms)
    mixture: Array  # stored mixture, float64 full scale


def read_wav_float(path: Path) -> Array:
    return vcorpus.read_wav(path).astype(np.float64) / 32768.0


def regenerate(m: dict[str, Any], root: Path) -> tuple[Components | None, dict[str, Any]]:
    """Returns the components and a check record for one manifest mixture."""
    check: dict[str, Any] = {"id": m["id"]}
    wav = root / m["wav"]
    if not wav.exists():
        check["status"] = "missing"
        return None, check
    check["hashOk"] = vc.sha256_file(wav) == m["wav_sha256"]
    check["refHashOk"] = vc.sha256_file(root / m["ref"]) == m["ref_sha256"]
    split_idx, li = vc.SPLITS.index(m["split"]), vc.LANGUAGES.index(m["language"])
    seq = np.random.default_rng([vc.CORPUS_SEED, 3, split_idx, li, m["scene"]])
    clean, ref, _ = vcorpus.build_scene(m["sentences"], root / "utterances", seq)
    stored = vcorpus.read_wav(wav)
    regen = vcorpus.mix(clean, ref, m["noise"], m["snr"], np.random.default_rng(m["seed"]))
    check["regenExact"] = bool(len(regen) == len(stored) and np.array_equal(regen, stored))
    check["refExact"] = bool(np.array_equal(ref, np.load(root / m["ref"])))
    if not (check["hashOk"] and check["regenExact"] and check["refExact"]):
        check["status"] = "unverifiable"
        return None, check
    # Reproduce the generator's scaling to recover the clean component as stored.
    rng = np.random.default_rng(m["seed"])
    n = len(clean)
    if m["snr"] == "clean":
        noise = GENERATORS["white"](n, rng) * 10 ** (vc.CLEAN_FLOOR_DBFS / 20)
    else:
        noise = GENERATORS[m["noise"]](n, rng)
        speech = np.repeat(ref, vc.FRAME)
        gain = math.sqrt(
            float(np.mean(clean[speech] ** 2))
            / (float(np.mean(noise[speech] ** 2)) * 10 ** (m["snr"] / 10))
        )
        noise = gain * noise
    mixed = clean + noise
    peak = float(np.max(np.abs(mixed)))
    k = 0.98 / peak if peak > 0.98 else 1.0  # noqa: PLR2004 (the generator's constant)
    mixture = stored.astype(np.float64) / 32768.0
    comp = Components(clean=clean * k, noise=mixture - clean * k, ref=ref, mixture=mixture)
    speech = np.repeat(ref, vc.FRAME)[: len(mixture)]
    ps = float(np.mean(comp.clean[: len(speech)][speech] ** 2))
    pn = float(np.mean(comp.noise[: len(speech)][speech] ** 2))
    check["achievedSnrDb"] = 10 * math.log10(ps / pn) if pn > 0 else None
    check["targetSnr"] = m["snr"]
    check["refSpeechRatio"] = float(ref.mean())
    check["status"] = "verified"
    return comp, check
