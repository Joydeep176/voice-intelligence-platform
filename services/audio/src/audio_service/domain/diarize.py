"""`diarize` task: sherpa-onnx offline diarization (pyannote segmentation-3.0 + 3D-Speaker CAM++).

OD-03b / ADR-0037, bounded memory per ADR-0016:

- Up to `wholeFileMaxMs` the whole canonical audio is diarized in one pass.
- Above it the audio is split into windows of `windowMs` that overlap by `overlapMs`. Each window
  is diarized on its own; every window speaker gets one embedding (CAM++, from up to 30 s of its
  speech in that window) and joins the most similar global speaker when the cosine similarity is
  at least `matchThreshold` (each global speaker at most once per window), otherwise it becomes a
  new global speaker. A window owns the span between the middles of its overlaps; turns are clipped
  to the owned span, so every instant is labelled by exactly one window, and same-speaker turns
  that meet at an ownership boundary are joined. Memory is bounded by one window of samples.

Speaker keys are `SPEAKER_00`, `SPEAKER_01`, ... in order of first appearance. Times are integer
milliseconds on the canonical timeline. The canonical WAV is verified against the preprocessing
manifest (streamed SHA-256) before use.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib import metadata
from typing import Any, Protocol

import numpy as np
from pydantic import ValidationError

from audio_service.contracts import (
    DiarizeConfig,
    DiarizeEngine,
    DiarizeResult,
    DiarizeTurn,
    DiarizeWindow,
    ErrorCode,
    ModelRef,
)
from audio_service.domain.canonical_audio import CANONICAL_NAME, SAMPLES_PER_MS, CanonicalAudio
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.inference_models import (
    CAMPPLUS_EN_VOXCELEB,
    PYANNOTE_SEGMENTATION_3_0,
    ModelStore,
    ModelUnavailable,
)
from audio_service.domain.isolation import run_handler_isolated
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import StorageBackend
from audio_service.domain.tasks import TaskContext

log = logging.getLogger("audio_service.diarize")

#: Speech used for one window speaker's embedding (bounded work and memory).
EMBEDDING_MAX_MS = 30_000


class DiarEngine(Protocol):
    engine: DiarizeEngine

    def diarize(self, samples: np.ndarray) -> list[tuple[int, int, int]]:
        """Turns (start ms, end ms relative to the samples, local speaker index)."""

    def embed(self, samples: np.ndarray) -> np.ndarray:
        """L2-normalised speaker embedding of the samples."""

    def close(self) -> None: ...


class SherpaDiarEngine:
    """sherpa-onnx with the C3-benchmarked configuration (threshold from the task config)."""

    def __init__(self, models: ModelStore, threads: int, cfg: DiarizeConfig) -> None:
        import sherpa_onnx  # type: ignore[import-untyped]  # noqa: PLC0415 - heavy native import

        seg = models.path(PYANNOTE_SEGMENTATION_3_0)
        emb = models.path(CAMPPLUS_EN_VOXCELEB)
        self.engine = DiarizeEngine(
            id="sherpa-onnx",
            runtime=f"sherpa-onnx {metadata.version('sherpa-onnx')}",
            threads=threads,
            segmentation=ModelRef(
                model=PYANNOTE_SEGMENTATION_3_0.name, sha256=PYANNOTE_SEGMENTATION_3_0.sha256
            ),
            embedding=ModelRef(model=CAMPPLUS_EN_VOXCELEB.name, sha256=CAMPPLUS_EN_VOXCELEB.sha256),
        )
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(seg)),
                num_threads=threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(emb), num_threads=threads
            ),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=-1, threshold=cfg.clusteringThreshold
            ),
            min_duration_on=cfg.minDurationOnMs / 1000,
            min_duration_off=cfg.minDurationOffMs / 1000,
        )
        if not config.validate():
            raise TaskFailure(ErrorCode.INVALID_CONFIG)
        self._sd: Any = sherpa_onnx.OfflineSpeakerDiarization(config)
        self._ex: Any = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(emb), num_threads=threads)
        )

    def diarize(self, samples: np.ndarray) -> list[tuple[int, int, int]]:
        result = self._sd.process(samples).sort_by_start_time()
        return [(round(s.start * 1000), round(s.end * 1000), int(s.speaker)) for s in result]

    def embed(self, samples: np.ndarray) -> np.ndarray:
        stream = self._ex.create_stream()
        stream.accept_waveform(16_000, samples)
        stream.input_finished()
        vector = np.asarray(self._ex.compute(stream), dtype=np.float64)
        norm = float(np.linalg.norm(vector))
        return vector / norm if norm > 0 else vector

    def close(self) -> None:
        self._sd = None
        self._ex = None


def plan_windows(
    duration_ms: int, whole_max_ms: int, window_ms: int, overlap_ms: int
) -> list[tuple[int, int]]:
    """[(start, end)] covering [0, duration); one window when the file is short enough."""
    if duration_ms <= whole_max_ms:
        return [(0, duration_ms)]
    stride = window_ms - overlap_ms
    windows: list[tuple[int, int]] = []
    start = 0
    while True:
        end = min(start + window_ms, duration_ms)
        windows.append((start, end))
        if end >= duration_ms:
            return windows
        start += stride


def owned_span(windows: list[tuple[int, int]], i: int) -> tuple[int, int]:
    """Window i owns from the middle of its leading overlap to the middle of its trailing one."""
    start, end = windows[i]
    lo = start if i == 0 else (start + windows[i - 1][1]) // 2
    hi = end if i == len(windows) - 1 else (windows[i + 1][0] + end) // 2
    return lo, hi


@dataclass
class _Global:
    centroid: np.ndarray
    weight: float
    first_ms: int = field(default=0)


def match_speakers(
    globals_: list[_Global], local: dict[int, tuple[np.ndarray, float]], threshold: float
) -> dict[int, int]:
    """Greedy one-to-one assignment of window speakers to global speakers by cosine similarity
    (highest first); unmatched window speakers become new global speakers. Updates centroids."""
    pairs: list[tuple[float, int, int]] = []
    for lk, (vec, _w) in local.items():
        for gi, g in enumerate(globals_):
            norm = float(np.linalg.norm(g.centroid))
            sim = float(np.dot(vec, g.centroid) / norm) if norm > 0 else -1.0
            pairs.append((sim, lk, gi))
    pairs.sort(key=lambda p: (-p[0], p[1], p[2]))
    mapping: dict[int, int] = {}
    used: set[int] = set()
    for sim, lk, gi in pairs:
        if sim < threshold or lk in mapping or gi in used:
            continue
        mapping[lk] = gi
        used.add(gi)
    for lk in sorted(local):
        vec, weight = local[lk]
        if lk in mapping:
            g = globals_[mapping[lk]]
            g.centroid = g.centroid + vec * weight
            g.weight += weight
        else:
            mapping[lk] = len(globals_)
            globals_.append(_Global(centroid=vec * weight, weight=weight))
    return mapping


def _speech_for(samples: np.ndarray, turns: list[tuple[int, int]], limit_ms: int) -> np.ndarray:
    pieces: list[np.ndarray] = []
    total = 0
    for s, e in sorted(turns, key=lambda t: t[0] - t[1]):  # longest turns first
        take = min(e - s, limit_ms - total)
        if take <= 0:
            break
        pieces.append(samples[s * SAMPLES_PER_MS : (s + take) * SAMPLES_PER_MS])
        total += take
    return np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)


def diarize_windows(  # noqa: PLR0913
    engine: DiarEngine,
    read: Callable[[int, int], np.ndarray],
    windows: list[tuple[int, int]],
    *,
    match_threshold: float,
    check: Callable[[], None],
    progress: Callable[[float, int], None],
) -> tuple[list[DiarizeTurn], list[DiarizeWindow]]:
    globals_: list[_Global] = []
    kept: list[tuple[int, int, int]] = []  # (start, end, global index)
    infos: list[DiarizeWindow] = []
    for i, (start, end) in enumerate(windows):
        check()
        samples = read(start, end)
        local_turns = [(s, e, k) for s, e, k in engine.diarize(samples) if e > s]
        by_speaker: dict[int, list[tuple[int, int]]] = {}
        for s, e, k in local_turns:
            by_speaker.setdefault(k, []).append((s, e))
        if len(windows) == 1:
            mapping = {k: n for n, k in enumerate(sorted(by_speaker))}
        else:
            local: dict[int, tuple[np.ndarray, float]] = {}
            for k, spans in by_speaker.items():
                speech = _speech_for(samples, spans, EMBEDDING_MAX_MS)
                local[k] = (engine.embed(speech), float(sum(e - s for s, e in spans)))
            mapping = match_speakers(globals_, local, match_threshold)
        lo, hi = owned_span(windows, i)
        for s, e, k in local_turns:
            a, b = max(lo, start + s), min(hi, start + e, end)
            if b > a:
                kept.append((a, b, mapping[k]))
        infos.append(DiarizeWindow(startMs=start, endMs=end, localSpeakers=len(by_speaker)))
        progress((i + 1) / len(windows), end)

    kept.sort()
    merged: list[list[int]] = []
    for s, e, g in kept:
        # Join same-speaker turns that meet across an ownership boundary (clipping split them).
        if merged and merged[-1][2] == g and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e, g])
    order: dict[int, int] = {}
    for _s, _e, g in merged:
        order.setdefault(g, len(order))
    turns = [
        DiarizeTurn(startMs=s, endMs=e, speakerKey=f"SPEAKER_{order[g]:02d}") for s, e, g in merged
    ]
    return turns, infos


class DiarizeHandler:
    def __init__(  # noqa: PLR0913
        self,
        storage: Callable[[], StorageBackend | None],
        models: ModelStore,
        *,
        threads: int,
        deadline_per_audio_permille: int,
        engine_factory: Callable[[DiarizeConfig], DiarEngine] | None = None,
        isolate: bool = True,
        runner: Callable[[], SandboxRunner | None] | None = None,
    ) -> None:
        """`isolate=True` (production) runs the engines in a sandboxed child process
        (`isolation.py`)."""
        self._storage = storage
        self._models = models
        self._isolate = isolate
        self._runner = runner or (lambda: None)
        self._threads = threads
        self._permille = deadline_per_audio_permille
        self._factory = engine_factory or (lambda cfg: SherpaDiarEngine(models, threads, cfg))

    def __call__(self, ctx: TaskContext) -> dict[str, Any]:
        try:
            cfg = DiarizeConfig.model_validate(ctx.request.config)
        except ValidationError:
            raise TaskFailure(ErrorCode.INVALID_CONFIG) from None
        if self._isolate:
            runner = self._runner()
            if runner is None:
                raise TaskFailure(ErrorCode.INTERNAL_ERROR)  # the service has not started
            return run_handler_isolated(
                ctx,
                self._storage(),
                runner,
                DiarizeResult,
                models_dir=self._models.root,
                threads=self._threads,
                deadline_per_audio_permille=self._permille,
                budget_audio_ms=cfg.audioDurationMs,
            )
        storage = self._storage()
        if storage is None:
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        ctx.set_inference_budget(cfg.audioDurationMs, self._permille)
        published = storage.open_published_file(
            ctx.request.input.outputPrefix, ctx.refs, CANONICAL_NAME
        )
        with CanonicalAudio(published) as audio:
            if abs(cfg.audioDurationMs - audio.duration_ms) > 1:  # integer ms vs samples / 16
                raise TaskFailure(ErrorCode.INVALID_CONFIG)
            audio.verify()
            ctx.check_cancelled()
            windows = plan_windows(
                audio.duration_ms, cfg.wholeFileMaxMs, cfg.windowMs, cfg.overlapMs
            )
            try:
                engine = self._factory(cfg)
            except ModelUnavailable:
                raise TaskFailure(ErrorCode.UNSUPPORTED_TASK_TYPE) from None
            try:
                turns, infos = diarize_windows(
                    engine,
                    audio.read_ms,
                    windows,
                    match_threshold=float(cfg.matchThreshold),
                    check=ctx.check_cancelled,
                    progress=lambda f, ms: ctx.report_progress("diarize", f, ms),
                )
                info = engine.engine
            except (TaskCancelled, TaskFailure):
                raise
            except Exception:  # noqa: BLE001 - engine failure: a code, never the message
                log.exception("diarize_engine_failed", extra={"taskId": str(ctx.task_id)})
                raise TaskFailure(ErrorCode.INTERNAL_ERROR) from None
            finally:
                engine.close()
            canonical_sha = audio.sha256
        return DiarizeResult(
            schemaVersion=1,
            engine=info,
            mode="whole" if len(windows) == 1 else "windowed",
            canonicalSha256=canonical_sha,
            windows=infos,
            turns=turns,
            speakerCount=len({t.speakerKey for t in turns}),
            warnings=[],
        ).model_dump(mode="json")
