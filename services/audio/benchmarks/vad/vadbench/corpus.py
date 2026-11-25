"""Synthetic corpus generation (host only: uses macOS `say`). ADR-0004: synthetic, no real data."""

from __future__ import annotations

import platform
import subprocess  # noqa: S404
import wave
from pathlib import Path
from typing import Any

import numpy as np

from . import common as c
from .noise import GENERATORS
from .sentences import all_sentences

Array = np.ndarray


def read_wav(path: Path) -> Array:
    with wave.open(str(path), "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (c.SAMPLE_RATE, 1, 2):
            raise ValueError(f"unexpected WAV format: {path.name}")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").copy()


def write_wav(path: Path, samples: Array) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(c.SAMPLE_RATE)
        w.writeframes(samples.astype("<i2").tobytes())


def frame_rms_db(x: Array) -> Array:
    n = len(x) // c.FRAME
    frames = x[: n * c.FRAME].astype(np.float64).reshape(n, c.FRAME) / 32768.0
    return 10 * np.log10(np.mean(frames * frames, axis=1) + 1e-12)


def reference_frames(x: Array) -> Array:
    """Reference speech mask (10 ms) from a clean utterance: frame RMS within REF_REL_DB of peak.

    Short pauses (under 100 ms) inside speech are filled and speech runs under 30 ms are removed.
    """
    peak_db = 20 * np.log10(max(1, int(np.max(np.abs(x.astype(np.int32))))) / 32768.0)
    mask = frame_rms_db(x) >= peak_db - c.REF_REL_DB
    return _clean_mask(mask)


def _runs(mask: Array) -> list[tuple[int, int]]:
    padded = np.concatenate([[False], mask, [False]]).astype(np.int8)
    d = np.diff(padded)
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist(), strict=True))


def _clean_mask(mask: Array) -> Array:
    out = mask.copy()
    inv = _runs(~out)
    for s, e in inv:
        if s > 0 and e < len(out) and e - s < c.REF_FILL_FRAMES:
            out[s:e] = True
    for s, e in _runs(out):
        if e - s < c.REF_MIN_SPEECH_FRAMES:
            out[s:e] = False
    return out


def render_utterances(out_dir: Path) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for s in all_sentences():
        path = out_dir / f"{s['id']}.wav"
        subprocess.run(  # noqa: S603
            [
                "/usr/bin/say",
                "-v",
                s["voice"],
                "-o",
                str(path),
                "--data-format=LEI16@16000",
                "--",
                s["text"],
            ],
            check=True,
            capture_output=True,
        )
        raw = read_wav(path)
        ref = reference_frames(raw)
        runs = _runs(ref)
        if not runs:
            raise RuntimeError(f"no reference speech in {s['id']}")
        first = max(0, runs[0][0] - c.UTTERANCE_MARGIN_FRAMES)
        last = min(len(ref), runs[-1][1] + c.UTTERANCE_MARGIN_FRAMES)
        trimmed = raw[first * c.FRAME : last * c.FRAME]
        write_wav(path, trimmed)
        rows.append({**{k: v for k, v in s.items() if k != "text"}, "file": path.name})
    return rows


def assign_splits(ids_by_group: dict[str, list[str]]) -> dict[str, dict[str, list[str]]]:
    """Per language: DEV_PER_LANGUAGE sentences to dev (split evenly over a language's groups)."""
    rng = np.random.default_rng([c.CORPUS_SEED, 1])
    out: dict[str, dict[str, list[str]]] = {lang: {"dev": [], "test": []} for lang in c.LANGUAGES}
    lang_groups = {"english": ["en"], "hindi": ["hi"], "hinglish": ["hd", "hr"]}
    for lang, groups in lang_groups.items():
        per_group = c.DEV_PER_LANGUAGE // len(groups)
        for g in groups:
            ids = list(ids_by_group[g])
            rng.shuffle(ids)
            out[lang]["dev"] += sorted(ids[:per_group])
            out[lang]["test"] += sorted(ids[per_group:])
    return out


def build_scene(
    utt_ids: list[str], utt_dir: Path, rng: np.random.Generator
) -> tuple[Array, Array, list[dict[str, int]]]:
    """Concatenate utterances separated by gaps of 0.2-5 s (multiples of 10 ms).

    Returns float64 clean signal, reference frame mask and per-utterance reference spans (frames).
    """
    pieces: list[Array] = []
    masks: list[Array] = []
    spans: list[dict[str, int]] = []
    pos = 0

    def gap() -> int:
        return int(round(rng.uniform(*c.GAP_RANGE_S) / c.FRAME_S))

    for uid in utt_ids:
        g = gap()
        pieces.append(np.zeros(g * c.FRAME, dtype=np.int16))
        masks.append(np.zeros(g, dtype=bool))
        pos += g
        x = read_wav(utt_dir / f"{uid}.wav")
        ref = reference_frames(x)
        runs = _runs(ref)
        pieces.append(x[: len(ref) * c.FRAME])
        masks.append(ref)
        spans.append({"start_frame": pos + runs[0][0], "end_frame": pos + runs[-1][1]})
        pos += len(ref)
    g = gap()
    pieces.append(np.zeros(g * c.FRAME, dtype=np.int16))
    masks.append(np.zeros(g, dtype=bool))
    clean = np.concatenate(pieces).astype(np.float64) / 32768.0
    return clean, np.concatenate(masks), [{**s, "utterance": i} for i, s in enumerate(spans)]


def mix(clean: Array, ref: Array, noise_type: str, snr: Any, rng: np.random.Generator) -> Array:
    """Add noise at `snr` dB over reference speech frames, or the clean floor; return int16."""
    n = len(clean)
    if snr == "clean":
        noise = GENERATORS["white"](n, rng) * 10 ** (c.CLEAN_FLOOR_DBFS / 20)
        mixed = clean + noise
    else:
        noise = GENERATORS[noise_type](n, rng)
        speech = np.repeat(ref, c.FRAME)
        p_speech = float(np.mean(clean[speech] ** 2))
        p_noise = float(np.mean(noise[speech] ** 2))
        gain = np.sqrt(p_speech / (p_noise * 10 ** (snr / 10)))
        mixed = clean + gain * noise
    peak = float(np.max(np.abs(mixed)))
    if peak > 0.98:
        mixed *= 0.98 / peak
    return np.clip(np.rint(mixed * 32768.0), -32768, 32767).astype(np.int16)


def build_corpus(root: Path) -> dict[str, Any]:
    utt_dir = root / "utterances"
    utterances = render_utterances(utt_dir)
    by_group: dict[str, list[str]] = {}
    for u in utterances:
        by_group.setdefault(u["group"], []).append(u["id"])
    splits = assign_splits(by_group)
    mixtures: list[dict[str, Any]] = []
    scene_rng = np.random.default_rng([c.CORPUS_SEED, 2])
    for split in c.SPLITS:
        for li, lang in enumerate(c.LANGUAGES):
            ids = list(splits[lang][split])
            scene_rng.shuffle(ids)
            for scene in range(c.SCENES[split]):
                chosen = ids[scene * c.UTTERANCES_PER_SCENE : (scene + 1) * c.UTTERANCES_PER_SCENE]
                if len(chosen) != c.UTTERANCES_PER_SCENE:
                    raise RuntimeError("not enough sentences for the scene layout")
                seq = np.random.default_rng([c.CORPUS_SEED, 3, c.SPLITS.index(split), li, scene])
                clean, ref, spans = build_scene(chosen, utt_dir, seq)
                conditions = [("none", "clean")] + [
                    (nt, snr) for nt in c.NOISE_TYPES for snr in c.SNRS[1:]
                ]
                for nt, snr in conditions:
                    seed_seq = [c.CORPUS_SEED, 4, c.SPLITS.index(split), li, scene]
                    if nt != "none":
                        seed_seq.append(c.NOISE_TYPES.index(nt))
                    rng = np.random.default_rng(seed_seq)
                    audio = mix(clean, ref, nt, snr, rng)
                    mid = f"{split}-{lang}-s{scene}-{nt}-{snr}"
                    wav_path = root / "mixtures" / split / f"{mid}.wav"
                    ref_path = root / "refs" / split / f"{mid}.npy"
                    write_wav(wav_path, audio)
                    ref_path.parent.mkdir(parents=True, exist_ok=True)
                    np.save(ref_path, ref)
                    mixtures.append(
                        {
                            "id": mid,
                            "split": split,
                            "language": lang,
                            "scene": scene,
                            "noise": nt,
                            "snr": snr,
                            "seed": seed_seq,
                            "sentences": chosen,
                            "spans": spans,
                            "duration_s": len(audio) / c.SAMPLE_RATE,
                            "wav": str(wav_path.relative_to(root)),
                            "wav_sha256": c.sha256_file(wav_path),
                            "ref": str(ref_path.relative_to(root)),
                            "ref_sha256": c.sha256_file(ref_path),
                        }
                    )
    longs = build_long_files(root, mixtures)
    index = {
        "utterances": [{**u, "sha256": c.sha256_file(utt_dir / u["file"])} for u in utterances],
        "splits": splits,
        "mixtures": mixtures,
        "long_files": longs,
    }
    c.write_json(root / "index.json", index)
    return index


def build_long_files(root: Path, mixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """60 and 120 minute files made of distinct, shuffled test mixtures (no new audio content)."""
    test = [m for m in mixtures if m["split"] == "test"]
    order = np.random.default_rng([c.CORPUS_SEED, 5]).permutation(len(test)).tolist()
    out = []
    cursor = 0
    for minutes in (60, 120):
        parts: list[Array] = []
        refs: list[Array] = []
        used: list[str] = []
        total = 0
        while total < minutes * 60 * c.SAMPLE_RATE:
            m = test[order[cursor]]
            cursor += 1
            audio = read_wav(root / m["wav"])
            parts.append(audio)
            refs.append(np.load(root / m["ref"], allow_pickle=False))
            used.append(m["id"])
            total += len(audio)
        name = f"long-{minutes}"
        wav_path = root / "long" / f"{name}.wav"
        ref_path = root / "long" / f"{name}.npy"
        write_wav(wav_path, np.concatenate(parts))
        np.save(ref_path, np.concatenate(refs))
        out.append(
            {
                "id": name,
                "mixtures": used,
                "duration_s": total / c.SAMPLE_RATE,
                "wav": str(wav_path.relative_to(root)),
                "wav_sha256": c.sha256_file(wav_path),
                "ref": str(ref_path.relative_to(root)),
                "ref_sha256": c.sha256_file(ref_path),
            }
        )
    return out


def environment() -> dict[str, str]:
    sw = subprocess.run(  # noqa: S603
        ["/usr/bin/sw_vers", "-productVersion"], check=True, capture_output=True, text=True
    )
    return {
        "macos": sw.stdout.strip(),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "machine": platform.machine(),
    }
