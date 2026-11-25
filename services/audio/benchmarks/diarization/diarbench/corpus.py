"""Diarization corpus (host only: macOS `say`). Synthetic 2-4 voice conversations (ADR-0004).

Every voice reads original sentences from the Phase 2B list (English; Hinglish for the en_IN voices;
Hindi for Lekha). Turns alternate (sometimes the same speaker continues), with gaps and, for a
share of turns, a short overlap. Reference segments come from the speech frames of each utterance
(Phase 2B reference rule), so short intra-utterance pauses are filled and longer ones are silence.
"""

from __future__ import annotations

import platform
import subprocess  # noqa: S404
from pathlib import Path
from typing import Any

import numpy as np
from sttbench.common import SAMPLE_RATE, SEED, read_json, sha256_file, write_json

FRAME = 160
# Sentence groups each voice reads (Lekha is the only Hindi voice available on the host).
VOICE_GROUPS = {
    "Aman": ["en", "hr"],
    "Rishi": ["en", "hr"],
    "Tara": ["en", "hr"],
    "Daniel": ["en"],
    "Fred": ["en"],
    "Albert": ["en"],
    "Lekha": ["hi", "hd"],
}
SPEAKER_SETS = {
    2: [["Aman", "Daniel"], ["Rishi", "Fred"], ["Tara", "Albert"]],
    3: [["Aman", "Tara", "Fred"], ["Rishi", "Daniel", "Albert"], ["Tara", "Rishi", "Lekha"]],
    4: [
        ["Aman", "Rishi", "Daniel", "Fred"],
        ["Tara", "Albert", "Fred", "Lekha"],
        ["Aman", "Tara", "Daniel", "Albert"],
    ],
}
TEST_MINUTES = [2, 5, 10]
DEV_MINUTES = 2
OVERLAP_PROB = 0.12
LONG_MINUTES = 60


def _render(voice: str, text: str, path: Path) -> None:
    subprocess.run(  # noqa: S603
        ["/usr/bin/say", "-v", voice, "-o", str(path), "--data-format=LEI16@16000", "--", text],  # noqa: S607
        check=True,
        capture_output=True,
    )


def render_voices(vad_corpus: Path, out: Path) -> dict[str, dict[str, Any]]:
    """Render every (voice, sentence) pair once; returns {key: {voice, id, file, sha256}}."""
    from vadbench import corpus as vc  # noqa: PLC0415
    from vadbench.sentences import all_sentences  # noqa: PLC0415

    del vad_corpus
    rendered: dict[str, dict[str, Any]] = {}
    for s in all_sentences():
        for voice, groups in VOICE_GROUPS.items():
            if s["group"] not in groups:
                continue
            key = f"{voice}/{s['id']}"
            path = out / "voice-utts" / voice / f"{s['id']}.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                _render(voice, s["text"], path)
                raw = vc.read_wav(path)
                ref = vc.reference_frames(raw)
                runs = vc._runs(ref)  # noqa: SLF001
                if not runs:
                    raise RuntimeError(f"no speech in {key}")
                lo = max(0, runs[0][0] - 5) * FRAME
                hi = min(len(ref), runs[-1][1] + 5) * FRAME
                vc.write_wav(path, raw[lo:hi])
            rendered[key] = {
                "voice": voice,
                "id": s["id"],
                "group": s["group"],
                "file": str(path.relative_to(out)),
                "sha256": sha256_file(path),
            }
    return rendered


def build_conversation(  # noqa: PLR0913, PLR0917, PLR0915
    conv_id: str,
    voices: list[str],
    minutes: float,
    pool_ids: set[str],
    out: Path,
    rng: np.random.Generator,
) -> dict[str, Any]:
    from vadbench import corpus as vc  # noqa: PLC0415

    target = int(minutes * 60 * SAMPLE_RATE)
    pools: dict[str, list[str]] = {}
    for v in voices:
        ids = sorted(p.stem for p in (out / "voice-utts" / v).glob("*.wav") if p.stem in pool_ids)
        pools[v] = ids
    queues: dict[str, list[str]] = {v: [] for v in voices}

    def next_utt(v: str) -> str:
        if not queues[v]:
            queues[v] = list(rng.permutation(pools[v]))
        return queues[v].pop()

    mix = np.zeros(target + 30 * SAMPLE_RATE, dtype=np.float64)
    segments: list[dict[str, Any]] = []
    cursor = int(rng.uniform(0.3, 1.0) * SAMPLE_RATE)
    prev_spk: str | None = None
    prev_end = 0
    turn_utts = 0
    while cursor < target:
        if prev_spk is None or rng.random() < 0.15:
            spk = prev_spk or voices[int(rng.integers(len(voices)))]
        else:
            spk = voices[int(rng.integers(len(voices)))]
            while spk == prev_spk:
                spk = voices[int(rng.integers(len(voices)))]
        if spk == prev_spk:  # a speaker never overlaps themself
            cursor = max(cursor, prev_end + int(0.2 * SAMPLE_RATE))
        start = cursor
        for _ in range(int(rng.integers(1, 3))):  # one or two utterances per turn
            uid = next_utt(spk)
            x = vc.read_wav(out / "voice-utts" / spk / f"{uid}.wav")
            ref = vc.reference_frames(x)
            n = len(ref) * FRAME
            mix[start : start + n] += x[:n].astype(np.float64) / 32768.0
            for a, b in vc._runs(ref):  # noqa: SLF001
                segments.append(
                    {
                        "speaker": spk,
                        "start": round((start + a * FRAME) / SAMPLE_RATE, 3),
                        "end": round((start + b * FRAME) / SAMPLE_RATE, 3),
                        "utterance": uid,
                    }
                )
            start += n + int(rng.uniform(0.1, 0.35) * SAMPLE_RATE)
            turn_utts += 1
        turn_end = start
        prev_end = max(prev_end, turn_end)
        r = rng.random()
        if r < OVERLAP_PROB:
            cursor = turn_end - int(rng.uniform(0.3, 1.0) * SAMPLE_RATE)
        elif r < OVERLAP_PROB + 0.05:
            cursor = turn_end + int(rng.uniform(3.0, 6.0) * SAMPLE_RATE)
        else:
            cursor = turn_end + int(rng.uniform(0.2, 1.5) * SAMPLE_RATE)
        prev_spk = spk
    total = min(len(mix), max(prev_end, cursor) + SAMPLE_RATE)
    sig = mix[:total]
    sig = sig + rng.standard_normal(len(sig)) * 10 ** (-70 / 20)
    peak = float(np.max(np.abs(sig)))
    if peak > 0.98:
        sig *= 0.98 / peak
    pcm = np.clip(np.rint(sig * 32768.0), -32768, 32767).astype(np.int16)
    path = out / "conversations" / f"{conv_id}.wav"
    vc.write_wav(path, pcm)
    segments.sort(key=lambda s: (s["start"], s["end"]))
    return {
        "id": conv_id,
        "file": str(path.relative_to(out)),
        "speakers": voices,
        "n_speakers": len(voices),
        "seconds": round(len(pcm) / SAMPLE_RATE, 2),
        "turn_utterances": turn_utts,
        "segments": segments,
        "sha256": sha256_file(path),
    }


def build(vad_corpus: Path, out: Path) -> dict[str, Any]:
    index = read_json(vad_corpus / "index.json")
    rendered = render_voices(vad_corpus, out)

    def pool(split: str) -> set[str]:
        return {i for lang in index["splits"].values() for i in lang[split]}

    pools = {"dev": pool("dev"), "test": pool("test")}
    convs: list[dict[str, Any]] = []
    k = 0
    for n, sets in SPEAKER_SETS.items():
        # dev: one 2 min conversation per speaker count (clustering threshold is tuned here)
        rng = np.random.default_rng([SEED, 21, k])
        c = build_conversation(f"dev-{n}spk-a", sets[0], DEV_MINUTES, pools["dev"], out, rng)
        convs.append({**c, "split": "dev"})
        k += 1
        for letter, (voices, minutes) in zip(
            "abc", zip(sets, TEST_MINUTES, strict=True), strict=True
        ):
            rng = np.random.default_rng([SEED, 21, k])
            c = build_conversation(
                f"test-{n}spk-{letter}-{minutes}min", voices, minutes, pools["test"], out, rng
            )
            convs.append({**c, "split": "test"})
            k += 1
    rng = np.random.default_rng([SEED, 22, 0])
    c = build_conversation(
        "long-60min-4spk", SPEAKER_SETS[4][0], LONG_MINUTES, pools["test"], out, rng
    )
    convs.append({**c, "split": "long"})
    manifest = {
        "environment": {"machine": platform.machine(), "macos": platform.mac_ver()[0]},
        "seed": SEED,
        "overlap_probability_per_turn": OVERLAP_PROB,
        "voice_groups": VOICE_GROUPS,
        "voice_utterances": rendered,
        "conversations": convs,
    }
    write_json(out / "index.json", manifest)
    return manifest
