"""Container-side diarization stages: tune (dev), evaluate (test), resources (1 CPU, 60 min)."""

from __future__ import annotations

import hashlib
import json
import os
import statistics
import time
from pathlib import Path
from typing import Any

import numpy as np
from sttbench import cgroup
from sttbench.common import log, read_json, sha256_file, verified_model_path, write_json
from sttbench.evaluate import read_wav_f32

from .der import der

EMBEDDINGS = {
    "campplus": ("emb-campplus-en", "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"),
    "wespeaker": ("emb-wespeaker-r34", "wespeaker_en_voxceleb_resnet34_LM.onnx"),
}
THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
DEFAULT_THRESHOLD = 0.5
ORACLE_MAX_S = 400  # oracle speaker count only up to 5 min conversations (compute budget)


def make_diarizer(candidate: str, models: Path, threads: int, threshold: float, k: int = -1) -> Any:
    import sherpa_onnx  # noqa: PLC0415

    seg = verified_model_path(models, "diar-segmentation", "model.onnx")
    mid, name = EMBEDDINGS[candidate]
    emb = verified_model_path(models, mid, name)
    cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)),
            num_threads=threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=threads),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=k, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not cfg.validate():
        raise RuntimeError("invalid diarization config")
    return sherpa_onnx.OfflineSpeakerDiarization(cfg)


def run(sd: Any, samples: np.ndarray) -> list[dict[str, Any]]:
    result = sd.process(samples).sort_by_start_time()
    return [
        {"speaker": f"spk{s.speaker}", "start": round(s.start, 3), "end": round(s.end, 3)}
        for s in result
    ]


def _score(corpus: Path, conv: dict[str, Any], hyp: list[dict[str, Any]]) -> dict[str, float]:
    return der(conv["segments"], hyp, conv["seconds"])


def tune(candidate: str, corpus: Path, models: Path, threads: int, out: Path) -> None:
    index = read_json(corpus / "index.json")
    dev = [c for c in index["conversations"] if c["split"] == "dev"]
    audio = {c["id"]: read_wav_f32(corpus / c["file"]) for c in dev}
    grid = []
    for th in THRESHOLDS:
        sd = make_diarizer(candidate, models, threads, th)
        ders = [_score(corpus, c, run(sd, audio[c["id"]]))["der"] for c in dev]
        grid.append({"threshold": th, "mean_der": float(np.mean(ders)), "ders": ders})
    best = min(grid, key=lambda g: (g["mean_der"], g["threshold"]))
    write_json(out / f"diar-tuning-{candidate}.json", {"grid": grid, "selected": best["threshold"]})
    log(f"tune {candidate}: threshold {best['threshold']} dev DER {best['mean_der']:.4f}")


def evaluate(  # noqa: PLR0913, PLR0917
    candidate: str,
    corpus: Path,
    models: Path,
    threads: int,
    out: Path,
    tag: str,
    limit: int | None = None,
) -> None:
    index = read_json(corpus / "index.json")
    tuned = read_json(out / f"diar-tuning-{candidate}.json")["selected"]
    rows = []
    digest = hashlib.sha256()
    convs = [c for c in index["conversations"] if c["split"] in {"dev", "test"}]
    if limit == 1:  # determinism re-run: dev and the 2 minute conversations only
        convs = [c for c in convs if c["split"] == "dev" or c["id"].endswith("-2min")]
    elif limit == 2:  # noqa: PLR2004  (compute budget: conversations up to 5 minutes)
        convs = [c for c in convs if c["seconds"] < ORACLE_MAX_S]
    for conv in convs:
        x = read_wav_f32(corpus / conv["file"])
        row: dict[str, Any] = {
            "id": conv["id"],
            "split": conv["split"],
            "n_speakers": conv["n_speakers"],
            "seconds": conv["seconds"],
        }
        modes = [("tuned", tuned, -1)]
        if conv["seconds"] < ORACLE_MAX_S:
            modes.append(("oracle_k", tuned, conv["n_speakers"]))
        for mode, th, k in modes:
            sd = make_diarizer(candidate, models, threads, th, k)
            hyp = run(sd, x)
            digest.update(json.dumps(hyp, sort_keys=True).encode())
            row[mode] = _score(corpus, conv, hyp)
            row[mode]["threshold"] = th
        rows.append(row)
    write_json(
        out / f"diar-eval-{candidate}-{tag}.json",
        {
            "candidate": candidate,
            "threads": threads,
            "tuned_threshold": tuned,
            "hypotheses_sha256": digest.hexdigest(),
            "model_files": {
                "segmentation": sha256_file(
                    verified_model_path(models, "diar-segmentation", "model.onnx")
                ),
                "embedding": sha256_file(verified_model_path(models, *EMBEDDINGS[candidate])),
            },
            "rows": rows,
        },
    )
    log(f"diar evaluate {candidate} [{tag}]: {len(rows)} conversations")


def resources(  # noqa: PLR0913, PLR0917
    candidate: str, corpus: Path, models: Path, out: Path, long_minutes: float, tag: str
) -> None:
    """Load time, RTF (median of 3) on a 5 min conversation, then the 60 min file once."""
    threads = int(os.environ.get("BENCH_THREADS", "1"))
    index = read_json(corpus / "index.json")
    tuned = read_json(out / f"diar-tuning-{candidate}.json")["selected"]
    mid = next(c for c in index["conversations"] if c["id"] == "test-3spk-b-5min")
    long_c = next(c for c in index["conversations"] if c["split"] == "long")
    sampler = cgroup.AnonSampler()
    sampler.start()
    t0 = time.perf_counter()
    sd = make_diarizer(candidate, models, threads, tuned)
    load_s = time.perf_counter() - t0
    x = read_wav_f32(corpus / mid["file"])
    runs = []
    for _ in range(1 if tag == "512m" else 3):  # the 512 MiB run is feasibility, not timing
        w0, c0 = time.perf_counter(), time.process_time()
        run(sd, x)
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        runs.append(
            {
                "wall_s": wall,
                "cpu_s": cpu,
                "rtf": wall / mid["seconds"],
                "cpu_per_audio_h": cpu / mid["seconds"] * 3600,
            }
        )
    base: dict[str, Any] = {
        "candidate": candidate,
        "threads": threads,
        "tuned_threshold": tuned,
        "load_s": load_s,
        "model_disk_bytes": sum(
            p.stat().st_size
            for p in (
                verified_model_path(models, "diar-segmentation", "model.onnx"),
                verified_model_path(models, *EMBEDDINGS[candidate]),
            )
        ),
        "short": {
            "audio_s": mid["seconds"],
            "runs": runs,
            "rtf_median": statistics.median(r["rtf"] for r in runs),
            "cpu_s_per_audio_hour_median": statistics.median(r["cpu_per_audio_h"] for r in runs),
        },
        "memory_peak_after_short_mib": (cgroup.read_int("memory.peak") or 0) / cgroup.MIB,
        "cgroup_memory_max": cgroup.read_text("memory.max"),
        "cgroup_cpu_max": cgroup.read_text("cpu.max"),
    }
    write_json(
        out / f"diar-resources-{candidate}-{tag}.json", {**base, "long": None, "completed": False}
    )
    long = None
    if long_minutes > 0:
        del x
        xl = read_wav_f32(corpus / long_c["file"])[: int(long_minutes * 60 * 16000)]
        ls = cgroup.AnonSampler()
        ls.start()
        w0, c0 = time.perf_counter(), time.process_time()
        hyp = run(sd, xl)
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        ls.stop()
        scored = der(
            [s for s in long_c["segments"] if s["end"] <= len(xl) / 16000],
            hyp,
            len(xl) / 16000,
        )
        long = {
            "audio_s": len(xl) / 16000,
            "wall_s": wall,
            "cpu_s": cpu,
            "rtf": wall / (len(xl) / 16000),
            "cpu_s_per_audio_hour": cpu / (len(xl) / 16000) * 3600,
            "hyp_speakers": scored["hyp_speakers"],
            "der": scored["der"],
            **ls.summary(),
        }
    sampler.stop()
    write_json(
        out / f"diar-resources-{candidate}-{tag}.json",
        {
            **base,
            "long": long,
            "completed": True,
            "memory_peak_mib": (cgroup.read_int("memory.peak") or 0) / cgroup.MIB,
            **sampler.summary(),
        },
    )
    log(f"diar resources {candidate}: rtf={base['short']['rtf_median']:.3f}")
