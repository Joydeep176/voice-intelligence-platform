"""STT corpus (host side): noisy single-utterance clips from the Phase 2B synthetic TTS corpus.

Speech is the macOS TTS from `.local-benchmarks/vad-corpus/utterances` (ADR-0004: synthetic,
original sentences, no real people or data). Each clip is a test or dev sentence with 0.5 s of
silence on both sides, mixed at clean / 20 / 10 / 5 dB with the Phase 2B generators (a seeded noise
type per clip).
"""

from __future__ import annotations

import platform
from pathlib import Path
from typing import Any

import numpy as np

from .common import SAMPLE_RATE, SEED, SNRS, read_json, sha256_file, write_json

PER_LANGUAGE_TEST = {"english": 20, "hindi": 20, "hinglish": 20}  # hinglish: 10 hd + 10 hr
DEV_PER_LANGUAGE = 6
PAD = SAMPLE_RATE // 2


def build(vad_corpus: Path, out: Path) -> dict[str, Any]:
    from vadbench import corpus as vc  # noqa: PLC0415
    from vadbench.noise import GENERATORS  # noqa: PLC0415
    from vadbench.sentences import all_sentences  # noqa: PLC0415

    noise_types = sorted(GENERATORS)
    index = read_json(vad_corpus / "index.json")
    sentences = {s["id"]: s for s in all_sentences()}
    rng = np.random.default_rng([SEED, 11])
    clips: list[dict[str, Any]] = []

    def pick(language: str, split: str, n: int) -> list[str]:
        ids = sorted(index["splits"][language][split])
        if language == "hinglish":
            groups = [[i for i in ids if i.startswith(g)] for g in ("hd-", "hr-")]
        else:
            groups = [ids]
        per = n // len(groups)
        chosen: list[str] = []
        for g in groups:
            chosen += sorted(rng.choice(g, size=min(per, len(g)), replace=False).tolist())
        return chosen

    plan = {
        "test": {lang: pick(lang, "test", n) for lang, n in PER_LANGUAGE_TEST.items()},
        "dev": {lang: pick(lang, "dev", DEV_PER_LANGUAGE) for lang in PER_LANGUAGE_TEST},
    }
    for split, by_lang in plan.items():
        snrs = SNRS if split == "test" else ["clean"]
        for language, ids in by_lang.items():
            for sid in ids:
                x = vc.read_wav(vad_corpus / "utterances" / f"{sid}.wav")
                ref = vc.reference_frames(x)
                n = len(ref) * 160
                x = x[:n]
                clean = (
                    np.concatenate([np.zeros(PAD, np.int16), x, np.zeros(PAD, np.int16)]).astype(
                        np.float64
                    )
                    / 32768.0
                )
                ref_p = np.concatenate(
                    [np.zeros(PAD // 160, bool), ref, np.zeros(PAD // 160, bool)]
                )
                for si, snr in enumerate(snrs):
                    nrng = np.random.default_rng([SEED, 12, int(sid[-3:]), ord(sid[0]), si])
                    noise = noise_types[int(nrng.integers(len(noise_types)))]
                    mixed = vc.mix(clean, ref_p, noise, snr, nrng)
                    name = f"{split}/{sid}-{snr}.wav"
                    vc.write_wav(out / "clips" / name, mixed)
                    s = sentences[sid]
                    clips.append(
                        {
                            "file": f"clips/{name}",
                            "id": sid,
                            "split": split,
                            "language": language,
                            "group": s["group"],
                            "voice": s["voice"],
                            "snr": snr,
                            "noise": noise if snr != "clean" else "white-floor",
                            "seconds": round(len(mixed) / SAMPLE_RATE, 3),
                            "text": s["text"],
                            "sha256": sha256_file(out / "clips" / name),
                        }
                    )
    # Timing file for the RTF runs: 40 clean test utterances (mixed languages), 0.5 s gaps.
    rtf_ids = [i for lang in ("english", "hindi", "hinglish") for i in plan["test"][lang]][:40]
    pieces: list[np.ndarray] = []
    for sid in rtf_ids:
        pieces += [vc.read_wav(vad_corpus / "utterances" / f"{sid}.wav"), np.zeros(PAD, np.int16)]
    vc.write_wav(out / "rtf-mixed.wav", np.concatenate(pieces))
    manifest = {
        "environment": {"machine": platform.machine(), "macos": platform.mac_ver()[0]},
        "seed": SEED,
        "snrs": SNRS,
        "noise_types": noise_types,
        "per_language_test": PER_LANGUAGE_TEST,
        "dev_per_language": DEV_PER_LANGUAGE,
        "clips": clips,
        "rtf_file": {
            "file": "rtf-mixed.wav",
            "sentences": rtf_ids,
            "sha256": sha256_file(out / "rtf-mixed.wav"),
        },
    }
    write_json(out / "index.json", manifest)
    return manifest
