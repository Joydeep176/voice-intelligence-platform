"""Container-side STT stages: accuracy (per clip), and resources (RTF, memory, 60 min file)."""

from __future__ import annotations

import hashlib
import os
import statistics
import time
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np

from . import cgroup
from .common import SAMPLE_RATE, log, read_json, sha256_file, write_json
from .engines import CHUNK_S, make_engine

RTF_AUDIO_S = 60.0  # two full 30 s windows per RTF pass (Whisper cost is per window)


def read_wav_f32(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise ValueError(f"unexpected WAV format: {path.name}")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def iter_chunks(
    path: Path, seconds: float = CHUNK_S, limit_s: float | None = None
) -> Iterator[np.ndarray]:
    """Fixed windows read incrementally (bounded memory); no VAD, no overlap."""
    step = int(seconds * SAMPLE_RATE)
    total = None if limit_s is None else int(limit_s * SAMPLE_RATE)
    done = 0
    with wave.open(str(path), "rb") as w:
        while True:
            n = step if total is None else min(step, total - done)
            if n <= 0:
                return
            raw = w.readframes(n)
            if not raw:
                return
            done += len(raw) // 2
            yield np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def accuracy(  # noqa: PLR0913, PLR0917
    engine_id: str,
    corpus: Path,
    models: Path,
    threads: int,
    out: Path,
    tag: str,
    limit: int | None,
    snrs: list[str] | None = None,
    per_language: int | None = None,
) -> None:
    index = read_json(corpus / "index.json")
    clips = [c for c in index["clips"] if c["split"] == "test"]
    if snrs:  # e.g. the "headline" subset: clean and 10 dB only (compute budget)
        clips = [c for c in clips if str(c["snr"]) in snrs]
    if per_language:  # first N sentences per language (Hinglish: N/2 per kind), compute budget
        keep: dict[str, list[str]] = {}
        for c in clips:
            key = c["group"] if c["language"] == "hinglish" else c["language"]
            ids = keep.setdefault(key, [])
            if c["id"] not in ids and len(ids) < (
                per_language // 2 if key in {"hd", "hr"} else per_language
            ):
                ids.append(c["id"])
        clips = [
            c
            for c in clips
            if c["id"] in keep[c["group"] if c["language"] == "hinglish" else c["language"]]
        ]
    clips = clips[:limit] if limit else clips
    engine = make_engine(engine_id, models, threads)
    engine.load()
    engine.transcribe(read_wav_f32(corpus / clips[0]["file"]))  # warm-up, discarded
    rows = []
    for clip in clips:
        x = read_wav_f32(corpus / clip["file"])
        t0 = time.perf_counter()
        r = engine.transcribe(x)
        wall = time.perf_counter() - t0
        rows.append({"file": clip["file"], "hyp": r.text, "lang": r.lang, "wall_s": wall})
    digest = hashlib.sha256(
        "\n".join(f"{r['file']}\t{r['hyp']}\t{r['lang']}" for r in rows).encode()
    )
    write_json(
        out / f"accuracy-{engine_id}-{tag}.json",
        {
            "engine": engine.name,
            "engine_id": engine_id,
            "threads": threads,
            "model_files": {p.name: sha256_file(p) for p in engine.model_files()},
            "load_s": engine.load_s,
            "clips": len(rows),
            "hypotheses_sha256": digest.hexdigest(),
            "rows": rows,
        },
    )
    log(f"accuracy {engine_id} [{tag}]: {len(rows)} clips, load {engine.load_s:.1f}s")


def _transcribe_chunks(engine: Any, chunks: Iterator[np.ndarray]) -> tuple[int, int, int]:
    n_chunks = words = chars = 0
    for x in chunks:
        r = engine.transcribe(x)
        n_chunks += 1
        words += len(r.text.split())
        chars += len(r.text)
    return n_chunks, words, chars


def resources(  # noqa: PLR0913, PLR0917
    engine_id: str,
    corpus: Path,
    long_wav: Path | None,
    models: Path,
    out: Path,
    long_minutes: float,
    tag: str,
    budget_s: float = 420.0,
) -> None:
    """RTF (median of 3 over rtf-mixed.wav), load time, peak memory; then the long file once."""
    threads = int(os.environ.get("BENCH_THREADS", "1"))
    rtf_wav = corpus / "rtf-mixed.wav"
    anon0 = cgroup.stat("anon") or 0
    sampler = cgroup.AnonSampler()
    sampler.start()
    engine = make_engine(engine_id, models, threads)
    engine.load()
    anon_loaded = cgroup.stat("anon") or 0
    engine.transcribe(read_wav_f32(rtf_wav)[: 10 * SAMPLE_RATE])  # warm-up, discarded
    runs = []
    with wave.open(str(rtf_wav), "rb") as w:
        audio_s = min(w.getnframes() / SAMPLE_RATE, RTF_AUDIO_S)
    for _ in range(1 if tag == "512m" else 3):  # the 512 MiB run is feasibility, not timing
        w0, c0 = time.perf_counter(), time.process_time()
        _transcribe_chunks(engine, iter_chunks(rtf_wav, limit_s=audio_s))
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        runs.append(
            {
                "wall_s": wall,
                "cpu_s": cpu,
                "rtf": wall / audio_s,
                "cpu_per_audio_h": cpu / audio_s * 3600,
            }
        )
    short = {
        "audio_s": audio_s,
        "runs": runs,
        "rtf_median": statistics.median(r["rtf"] for r in runs),
        "cpu_s_per_audio_hour_median": statistics.median(r["cpu_per_audio_h"] for r in runs),
    }
    result: dict[str, Any] = {
        "engine": engine.name,
        "engine_id": engine_id,
        "threads": threads,
        "load_s": engine.load_s,
        "model_disk_bytes": sum(p.stat().st_size for p in engine.model_files()),
        "anon_before_mib": anon0 / cgroup.MIB,
        "anon_after_load_mib": anon_loaded / cgroup.MIB,
        "short": short,
        "cgroup_memory_max": cgroup.read_text("memory.max"),
        "cgroup_cpu_max": cgroup.read_text("cpu.max"),
    }
    # Written now so that an OOM kill during the long file still leaves the short-run evidence.
    result["memory_peak_after_short_mib"] = (cgroup.read_int("memory.peak") or 0) / cgroup.MIB
    write_json(
        out / f"resources-{engine_id}-{tag}.json", {**result, "long": None, "completed": False}
    )
    long: dict[str, Any] | None = None
    if long_wav is not None and long_minutes > 0:
        with wave.open(str(long_wav), "rb") as w:
            total_s = w.getnframes() / SAMPLE_RATE
        # Wall-time budget: slow engines process fewer minutes (reported as audio_s).
        limit = min(total_s, long_minutes * 60, budget_s / max(short["rtf_median"], 1e-3))
        l_sampler = cgroup.AnonSampler()
        l_sampler.start()
        w0, c0 = time.perf_counter(), time.process_time()
        n_chunks, words, chars = _transcribe_chunks(engine, iter_chunks(long_wav, limit_s=limit))
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        l_sampler.stop()
        long = {
            "audio_s": limit,
            "file_audio_s": total_s,
            "chunks": n_chunks,
            "words_emitted": words,
            "chars_emitted": chars,
            "wall_s": wall,
            "cpu_s": cpu,
            "rtf": wall / limit,
            "cpu_s_per_audio_hour": cpu / limit * 3600,
            **l_sampler.summary(),
        }
    sampler.stop()
    result.update(
        {
            "memory_peak_mib": (cgroup.read_int("memory.peak") or 0) / cgroup.MIB,
            "file_cache_final_mib": (cgroup.stat("file") or 0) / cgroup.MIB,
            **sampler.summary(),
        }
    )
    write_json(
        out / f"resources-{engine_id}-{tag}.json", {**result, "long": long, "completed": True}
    )
    peak = result["memory_peak_mib"]
    log(f"resources {engine_id}: rtf={short['rtf_median']:.3f} peak={peak:.0f} MiB")
