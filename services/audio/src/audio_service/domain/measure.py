"""`measure` task (Phase 3A, ADR-0045): speech-aware objective measurements of the canonical audio.

Numbers only, as for `preprocess` (ADR-0019): every quantity carries a unit, a kind (measured /
derived / estimate) and its method; values that cannot be computed are listed as `unavailable`
with a reason, never guessed. There is no category, score or verdict here: the Audio Quality
Agent (A1, orchestrator) interprets these numbers.

Method (validated as indicative in Phase 3A M0, `docs/development/phase3a-quality-benchmark/`):
- speech split: the pinned Silero VAD with the transcription settings (ADR-0038), streamed;
  speech frames = raw spans, noise frames = frames outside the padded spans (guard band);
- SNR: VAD split with power subtraction, 10 log10((Ps - Pn) / Pn) (an estimate, biased low on
  the synthetic corpus). Pn is the mean noise-frame power, except near-clean audio: when the
  median noise-frame power gives an SNR at or above `snrNearCleanDb`, Pn is that median for the
  recording and every block (speech missed by the VAD inflates the mean when the true noise is
  tiny; OD-52, M6);
- bandwidth: the long-term speech spectrum's edge (highest bin within `ltasDropDb` of its maximum
  above `ltasMinHz`);
- per-block series (`blockMs`, 1000 ms by default): speech ms and block SNR;
- spans per transcription window: global spans clipped to the 30 s / 1 s window grid (an
  approximation of the per-window VAD that transcription runs).

Memory is bounded: audio is read in 30 s blocks; only 10 ms frame powers (float32) and masks are
kept (about 7 MB for 4 h). Runs in the sandboxed inference child, like `transcribe`.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

import numpy as np
from pydantic import ValidationError

from audio_service.contracts import (
    ErrorCode,
    MeasureConfig,
    MeasureResult,
    SpeechSeries,
    Tier1Quantity,
    Tier1Record,
    Unavailable,
    VadInfo,
    VadSettings,
)
from audio_service.domain.canonical_audio import CANONICAL_NAME, SAMPLE_RATE, CanonicalAudio
from audio_service.domain.errors import TaskFailure
from audio_service.domain.inference_models import SILERO_VAD_V6_2_3, ModelStore, ModelUnavailable
from audio_service.domain.isolation import run_handler_isolated
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import StorageBackend
from audio_service.domain.tasks import TaskContext
from audio_service.domain.transcribe import SileroDetector, pad_and_merge

FRAME = 160  # 10 ms at 16 kHz
FFT_SIZE = 512
READ_BLOCK_MS = 30_000
EPS = 1e-20
MIN_SPEECH_SHARE = 0.25
MIN_NOISE_SHARE = 0.2
MIN_SPREAD_BLOCKS = 4
DB_DECIMALS = 3


class StreamingSilero(SileroDetector):
    """`SileroDetector` (same model and settings) fed block by block; spans in absolute ms."""

    def start(self) -> None:
        self._pending = np.zeros(0, dtype=np.float32)
        self._out: list[tuple[int, int]] = []

    def _drain(self) -> None:
        while not self._vad.empty():
            seg = self._vad.front
            begin = int(seg.start) // 16
            self._out.append((begin, begin + len(seg.samples) // 16))
            self._vad.pop()

    def feed(self, block: np.ndarray) -> None:
        data = np.concatenate([self._pending, block])
        usable = len(data) // self._window * self._window
        for i in range(0, usable, self._window):
            self._vad.accept_waveform(data[i : i + self._window])
            self._drain()
        self._pending = data[usable:]

    def finish(self) -> list[tuple[int, int]]:
        if len(self._pending):
            self._vad.accept_waveform(self._pending)
        self._vad.flush()
        self._drain()
        return self._out


def spans_to_mask(spans: list[tuple[int, int]], n_frames: int) -> np.ndarray:
    mask = np.zeros(n_frames, dtype=bool)
    for start, end in spans:
        a, b = max(0, start // 10), min(n_frames, -(-end // 10))
        if b > a:
            mask[a:b] = True
    return mask


def _db(x: float) -> float:
    return round(10.0 * math.log10(x), DB_DECIMALS)


class _Builder:
    def __init__(self) -> None:
        self.quantities: dict[str, Tier1Quantity] = {}
        self.unavailable: list[Unavailable] = []

    def add(  # noqa: PLR0913, PLR0917
        self,
        name: str,
        value: float | int | None,
        unit: str,
        kind: str,
        method: str,
        reason: str = "",
    ) -> None:  # noqa: PLR0913
        if value is None or (isinstance(value, float) and not math.isfinite(value)):
            self.unavailable.append(Unavailable(name=name, reason=reason or "not_computable"))
        else:
            self.quantities[name] = Tier1Quantity(value=value, unit=unit, kind=kind, method=method)  # type: ignore[arg-type]


def analyse(  # noqa: PLR0912, PLR0913, PLR0914, PLR0915, PLR0917
    read_block: Callable[[int, int], np.ndarray],
    duration_ms: int,
    cfg: MeasureConfig,
    speech_detector: StreamingSilero,
    check: Callable[[], None] = lambda: None,
    progress: Callable[[float, int], None] = lambda _f, _ms: None,
) -> tuple[Tier1Record, SpeechSeries, list[str]]:
    """Pure analysis over a block reader (testable without a model when `speech_detector` is a
    fake with the same `start` / `feed` / `finish` interface)."""
    # Pass 1: VAD and 10 ms frame power, streamed.
    speech_detector.start()
    powers: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    for start in range(0, duration_ms, READ_BLOCK_MS):
        check()
        block = read_block(start, min(duration_ms, start + READ_BLOCK_MS))
        speech_detector.feed(block)
        data = np.concatenate([carry, block])
        n = len(data) // FRAME
        frames = data[: n * FRAME].astype(np.float64).reshape(n, FRAME)
        powers.append(np.einsum("ij,ij->i", frames, frames).astype(np.float32) / FRAME)
        carry = data[n * FRAME :]
        progress(0.5 * min(1.0, (start + READ_BLOCK_MS) / duration_ms), start)
    spans = speech_detector.finish()
    power = np.concatenate(powers) if powers else np.zeros(0, dtype=np.float32)
    n_frames = len(power)
    speech = spans_to_mask(spans, n_frames)
    noise = ~spans_to_mask(pad_and_merge(spans, cfg.vad.paddingMs, duration_ms), n_frames)

    out = _Builder()
    warnings: list[str] = []
    speech_frames, noise_frames = int(speech.sum()), int(noise.sum())
    out.add(
        "speechMs",
        speech_frames * 10,
        "ms",
        "derived",
        "10 ms frames inside Silero speech spans (ADR-0038 settings)",
    )
    out.add(
        "speechRatio",
        round(speech_frames / n_frames, 6) if n_frames else None,
        "ratio",
        "derived",
        "speech frames / all frames",
        "no_frames",
    )
    out.add("speechSpanCount", len(spans), "count", "derived", "Silero speech spans before padding")
    ps = float(power[speech].mean()) if speech_frames else None
    pn = float(power[noise].mean()) if noise_frames else None
    out.add(
        "activeSpeechLevelDbfs",
        _db(ps) if ps and ps > EPS else None,
        "dBFS",
        "estimate",
        "mean power of speech frames (includes any noise in them)",
        "no_speech",
    )
    out.add(
        "nonSpeechLevelDbfs",
        _db(pn) if pn and pn > EPS else None,
        "dBFS",
        "estimate",
        "mean power of frames outside the padded speech spans",
        "no_noise_frames" if not noise_frames else "digital_silence",
    )
    snr_reason = (
        "no_speech"
        if not ps
        else "no_noise_frames"
        if pn is None
        else "digital_silence"
        if pn <= EPS
        else "non_positive"
    )
    # Near-clean switch: the median of noise-frame powers resists leaked speech.
    pn_snr = pn
    near_clean = False
    if ps and pn and pn > EPS and noise_frames:
        pn_med = float(np.median(power[noise]))
        if pn_med > EPS and ps > pn_med and _db((ps - pn_med) / pn_med) >= cfg.snrNearCleanDb:
            pn_snr, near_clean = pn_med, True
    snr = _db((ps - pn_snr) / pn_snr) if ps and pn_snr and pn_snr > EPS and ps > pn_snr else None
    out.add(
        "snrDb",
        snr,
        "dB",
        "estimate",
        "VAD split with power subtraction: 10 log10((Ps - Pn) / Pn); Pn = median noise-frame power"
        if near_clean
        else "VAD split with power subtraction: 10 log10((Ps - Pn) / Pn); Pn = mean noise-frame"
        " power; biased low (M0)",
        snr_reason,
    )

    # Per-block series and level spread.
    bf = cfg.blockMs // 10
    blocks = n_frames // bf + (1 if n_frames % bf else 0)
    speech_ms: list[int] = []
    block_snr: list[float | None] = []
    block_levels: list[float] = []
    for b in range(blocks):
        sl = slice(b * bf, min(n_frames, (b + 1) * bf))
        s, nz, pw = speech[sl], noise[sl], power[sl]
        speech_ms.append(int(s.sum()) * 10)
        if len(s) == 0 or s.mean() < MIN_SPEECH_SHARE:
            block_snr.append(None)
            continue
        psb = float(pw[s].mean())
        if psb > EPS:
            block_levels.append(10.0 * math.log10(psb))
        if near_clean:
            pnb = pn_snr
        else:
            pnb = float(pw[nz].mean()) if nz.mean() >= MIN_NOISE_SHARE else pn
        block_snr.append(_db((psb - pnb) / pnb) if pnb and pnb > EPS and psb > pnb else None)
    spread = None
    if len(block_levels) >= MIN_SPREAD_BLOCKS:
        q75, q25 = np.percentile(block_levels, [75, 25])
        spread = round(float(q75 - q25), DB_DECIMALS)
    out.add(
        "levelSpreadDb",
        spread,
        "dB",
        "estimate",
        f"inter-quartile range of {cfg.blockMs} ms speech-block levels",
        "too_few_speech_blocks",
    )

    # Spans per transcription window (30 s / 1 s grid), from global spans clipped to each window.
    hop = cfg.windowMs - cfg.overlapMs
    counts: list[int] = []
    for w0 in range(0, duration_ms, hop):
        w1 = min(duration_ms, w0 + cfg.windowMs)
        clipped = [(max(a, w0) - w0, min(b, w1) - w0) for a, b in spans if a < w1 and b > w0]
        counts.append(len(pad_and_merge(clipped, cfg.vad.paddingMs, w1 - w0)))
        if w1 == duration_ms:
            break
    out.add(
        "maxSpansPerWindow",
        max(counts) if counts else 0,
        "count",
        "derived",
        "max padded speech spans per 30 s transcription window (global spans clipped to it)",
    )

    # Pass 2: long-term speech spectrum (frames fully inside speech), streamed.
    win = np.hanning(FFT_SIZE)
    ltas = np.zeros(FFT_SIZE // 2 + 1)
    used = 0
    for start in range(0, duration_ms, READ_BLOCK_MS):
        check()
        block = read_block(start, min(duration_ms, start + READ_BLOCK_MS)).astype(np.float64)
        base = start * 16
        for s0 in range(0, len(block) - FFT_SIZE + 1, FFT_SIZE):
            f0, f1 = (base + s0) // FRAME, (base + s0 + FFT_SIZE - 1) // FRAME
            if f1 < n_frames and speech[f0 : f1 + 1].all():
                ltas += np.abs(np.fft.rfft(block[s0 : s0 + FFT_SIZE] * win)) ** 2
                used += 1
        progress(0.5 + 0.5 * min(1.0, (start + READ_BLOCK_MS) / duration_ms), start)
    edge = None
    if used:
        freqs = np.fft.rfftfreq(FFT_SIZE, 1 / SAMPLE_RATE)
        mean = ltas / used
        ref = float(mean[freqs >= cfg.ltasMinHz].max())
        if ref > 0:
            above = np.flatnonzero(10 * np.log10(np.maximum(mean, EPS) / ref) >= -cfg.ltasDropDb)
            edge = float(freqs[above[-1]])
    out.add(
        "bandwidthEdgeHz",
        edge,
        "Hz",
        "estimate",
        f"highest long-term speech spectrum bin within {cfg.ltasDropDb} dB of its maximum"
        f" above {cfg.ltasMinHz} Hz (Hann {FFT_SIZE})",
        "no_speech_frames",
    )
    if not spans:
        warnings.append("no_speech")
    record = Tier1Record(
        measurementsSchemaVersion=2,
        source="canonical",
        quantities=out.quantities,
        unavailable=out.unavailable,
    )
    series = SpeechSeries(schemaVersion=1, blockMs=cfg.blockMs, speechMs=speech_ms, snrDb=block_snr)
    return record, series, warnings


class MeasureHandler:
    def __init__(  # noqa: PLR0913
        self,
        storage: Callable[[], StorageBackend | None],
        models: ModelStore,
        *,
        threads: int,
        deadline_per_audio_permille: int,
        detector_factory: Callable[[VadSettings], StreamingSilero] | None = None,
        isolate: bool = True,
        runner: Callable[[], SandboxRunner | None] | None = None,
    ) -> None:
        self._storage = storage
        self._models = models
        self._threads = threads
        self._permille = deadline_per_audio_permille
        self._detector = detector_factory or (lambda s: StreamingSilero(models, s))
        self._isolate = isolate
        self._runner = runner or (lambda: None)

    def __call__(self, ctx: TaskContext) -> dict[str, Any]:
        try:
            cfg = MeasureConfig.model_validate(ctx.request.config)
        except ValidationError:
            raise TaskFailure(ErrorCode.INVALID_CONFIG) from None
        if self._isolate:
            runner = self._runner()
            if runner is None:
                raise TaskFailure(ErrorCode.INTERNAL_ERROR)
            return run_handler_isolated(
                ctx,
                self._storage(),
                runner,
                MeasureResult,
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
        try:
            detector = self._detector(cfg.vad)
        except ModelUnavailable:
            raise TaskFailure(ErrorCode.UNSUPPORTED_TASK_TYPE) from None
        try:
            with CanonicalAudio(published) as audio:
                if abs(cfg.audioDurationMs - audio.duration_ms) > 1:
                    raise TaskFailure(ErrorCode.INVALID_CONFIG)
                record, series, warnings = analyse(
                    audio.read_ms,
                    audio.duration_ms,
                    cfg,
                    detector,
                    check=ctx.check_cancelled,
                    progress=lambda f, ms: ctx.report_progress("measure", f, ms),
                )
        finally:
            detector.close()
        ctx.report_progress("measure", 1.0, cfg.audioDurationMs)
        return MeasureResult(
            schemaVersion=1,
            vad=VadInfo(
                model=SILERO_VAD_V6_2_3.name, sha256=SILERO_VAD_V6_2_3.sha256, settings=cfg.vad
            ),
            record=record,
            series=series,
            warnings=warnings,
        ).model_dump(mode="json")
