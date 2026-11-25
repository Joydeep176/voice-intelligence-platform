"""`transcribe` task: Silero VAD + whisper.cpp (Whisper small, q5_1) on one canonical-audio window.

OD-02b / ADR-0036, OD-29 / ADR-0038. Whisper decodes one language per pass: a 30 s window that
mixes speakers and languages is mistranscribed (forced Hindi) or translated (forced English),
which was measured on the C3 corpus. So inside the window Silero VAD finds speech spans, and each
span is decoded on its own with its own detected language (`en` or `hi`). The VAD runs and is
released before whisper is loaded; no speech means no whisper call. Engines are loaded per task
and released afterwards, sharing the container budget with the media tasks. Output text and
segmentation are the engine's own, unedited; times are absolute integer milliseconds.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Mapping, Sequence
from importlib import metadata
from typing import Any, Literal, Protocol

import numpy as np
from pydantic import ValidationError

from audio_service.contracts import (
    EngineInfo,
    ErrorCode,
    MsRange,
    TranscribeConfig,
    TranscribeResult,
    TranscribeSegment,
    TranscribeSpan,
    VadInfo,
    VadSettings,
)
from audio_service.domain.canonical_audio import (
    CANONICAL_NAME,
    SAMPLE_RATE,
    SAMPLES_PER_MS,
    CanonicalAudio,
)
from audio_service.domain.errors import TaskCancelled, TaskFailure
from audio_service.domain.inference_models import (
    SILERO_VAD_V6_2_3,
    WHISPER_SMALL_Q5_1,
    ModelStore,
    ModelUnavailable,
)
from audio_service.domain.isolation import run_handler_isolated
from audio_service.domain.runner import SandboxRunner
from audio_service.domain.storage import StorageBackend
from audio_service.domain.tasks import TaskContext

log = logging.getLogger("audio_service.transcribe")

Language = Literal["en", "hi"]

# Whisper's detector often reports Urdu (`ur`) for spoken Hindi: the speech is largely the same and
# only the script differs. Its probability counts towards `hi`, and the span is decoded as `hi`
# (Devanagari). Recorded in ADR-0036 as a known limitation.
_FOLDED: dict[Language, tuple[str, ...]] = {"hi": ("hi", "ur"), "en": ("en",)}
#: Whisper decodes at most 30 s per pass; a longer speech run is split by the VAD.
MAX_SPAN_MS = 29_000


class SpeechDetector(Protocol):
    def spans(self, samples: np.ndarray) -> list[tuple[int, int]]:
        """Speech spans (start ms, end ms) relative to the samples, in time order."""

    def close(self) -> None: ...


class SttEngine(Protocol):
    info: EngineInfo

    def detect(self, samples: np.ndarray) -> tuple[str | None, float | None, Mapping[str, float]]:
        """(detected code, its probability, probabilities of all languages)."""

    def transcribe(
        self, samples: np.ndarray, language: str
    ) -> list[tuple[int, int, str, float | None]]:
        """Segments as (start ms, end ms) relative to the samples, text, token probability."""

    def close(self) -> None: ...


class SileroDetector:
    """Silero VAD through sherpa-onnx (no extra package), Phase 2B-tuned settings."""

    def __init__(self, models: ModelStore, settings: VadSettings) -> None:
        import sherpa_onnx  # type: ignore[import-untyped]  # noqa: PLC0415

        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(models.path(SILERO_VAD_V6_2_3))
        cfg.silero_vad.threshold = float(settings.threshold)
        cfg.silero_vad.min_silence_duration = settings.minSilenceMs / 1000
        cfg.silero_vad.min_speech_duration = settings.minSpeechMs / 1000
        cfg.silero_vad.max_speech_duration = MAX_SPAN_MS / 1000
        cfg.sample_rate = SAMPLE_RATE
        cfg.num_threads = 1
        if not cfg.validate():
            raise TaskFailure(ErrorCode.INVALID_CONFIG)
        self._window = int(cfg.silero_vad.window_size)
        self._vad: Any = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)

    def spans(self, samples: np.ndarray) -> list[tuple[int, int]]:
        out: list[tuple[int, int]] = []

        def drain() -> None:
            while not self._vad.empty():
                seg = self._vad.front
                start = int(seg.start) // SAMPLES_PER_MS
                out.append((start, start + len(seg.samples) // SAMPLES_PER_MS))
                self._vad.pop()

        for i in range(0, len(samples), self._window):
            self._vad.accept_waveform(samples[i : i + self._window])
            drain()
        self._vad.flush()
        drain()
        return out

    def close(self) -> None:
        self._vad = None


def whisper_info(threads: int) -> EngineInfo:
    return EngineInfo(
        id="whisper-cpp",
        model=WHISPER_SMALL_Q5_1.name,
        modelSha256=WHISPER_SMALL_Q5_1.sha256,
        runtime=f"pywhispercpp {metadata.version('pywhispercpp')}",
        threads=threads,
    )


class WhisperCppEngine:
    """pywhispercpp binding of whisper.cpp; benchmarked settings (C3): language detected once per
    pass, then decoded with it, `no_context` (no conditioning on earlier text)."""

    def __init__(self, models: ModelStore, threads: int) -> None:
        from pywhispercpp.model import Model  # noqa: PLC0415 - heavy native import, per task

        path = models.path(WHISPER_SMALL_Q5_1)
        self.info = whisper_info(threads)
        self._model: Any = Model(
            str(path),
            n_threads=threads,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
            language="auto",
        )

    def detect(self, samples: np.ndarray) -> tuple[str | None, float | None, Mapping[str, float]]:
        (code, prob), probs = self._model.auto_detect_language(samples)
        return str(code), float(prob), {str(k): float(v) for k, v in probs.items()}

    def transcribe(
        self, samples: np.ndarray, language: str
    ) -> list[tuple[int, int, str, float | None]]:
        out: list[tuple[int, int, str, float | None]] = []
        for seg in self._model.transcribe(samples, language=language, no_context=True):
            prob = float(seg.probability)
            # whisper.cpp segment times are in units of 10 ms.
            text, start, end = str(seg.text), int(seg.t0) * 10, int(seg.t1) * 10
            out.append((start, end, text, None if math.isnan(prob) else prob))
        return out

    def close(self) -> None:
        self._model = None


def choose_language(probs: Mapping[str, float], hints: Sequence[str] | None) -> Language:
    """The supported language (`en`/`hi`, limited to the hints) with the highest probability; a tie
    or no evidence chooses the first candidate."""
    candidates: list[Language] = ["en", "hi"]
    if hints:
        candidates = [c for c in candidates if c in hints]
    best, best_p = candidates[0], -1.0
    for code in candidates:
        p = sum(probs.get(c, 0.0) for c in _FOLDED[code])
        if p > best_p:
            best, best_p = code, p
    return best


def pad_and_merge(
    spans: list[tuple[int, int]], padding_ms: int, length_ms: int
) -> list[tuple[int, int]]:
    """Pads each span (clipped to the window) and joins spans that then touch, unless the joined
    span would exceed `MAX_SPAN_MS`. Relative milliseconds, time order."""
    out: list[list[int]] = []
    for s, e in sorted(spans):
        a, b = max(0, s - padding_ms), min(length_ms, e + padding_ms)
        if b <= a:
            continue
        if out and a <= out[-1][1] and b - out[-1][0] <= MAX_SPAN_MS:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


class TranscribeHandler:
    def __init__(  # noqa: PLR0913
        self,
        storage: Callable[[], StorageBackend | None],
        models: ModelStore,
        *,
        threads: int,
        deadline_per_audio_permille: int,
        detector_factory: Callable[[VadSettings], SpeechDetector] | None = None,
        engine_factory: Callable[[], SttEngine] | None = None,
        isolate: bool = True,
        runner: Callable[[], SandboxRunner | None] | None = None,
    ) -> None:
        """`isolate=True` (production) runs the engines in a sandboxed child process
        (`isolation.py`); `False` runs them in-process (inside that child, and in unit tests with
        fakes)."""
        self._storage = storage
        self._models = models
        self._isolate = isolate
        self._runner = runner or (lambda: None)
        self._threads = threads
        self._permille = deadline_per_audio_permille
        self._detector = detector_factory or (lambda s: SileroDetector(models, s))
        self._factory = engine_factory or (lambda: WhisperCppEngine(models, threads))

    def __call__(self, ctx: TaskContext) -> dict[str, Any]:
        try:
            cfg = TranscribeConfig.model_validate(ctx.request.config)
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
                TranscribeResult,
                models_dir=self._models.root,
                threads=self._threads,
                deadline_per_audio_permille=self._permille,
                budget_audio_ms=cfg.window.endMs - cfg.window.startMs,
            )
        storage = self._storage()
        if storage is None:
            raise TaskFailure(ErrorCode.STORAGE_ERROR)
        start, end = cfg.window.startMs, cfg.window.endMs
        ctx.set_inference_budget(end - start, self._permille)
        published = storage.open_published_file(
            ctx.request.input.outputPrefix, ctx.refs, CANONICAL_NAME
        )
        with CanonicalAudio(published) as audio:
            if abs(cfg.audioDurationMs - audio.duration_ms) > 1:  # integer ms vs samples / 16
                raise TaskFailure(ErrorCode.INVALID_CONFIG)
            samples = audio.read_ms(start, end)
        ctx.check_cancelled()
        ctx.report_progress("transcribe", 0.0, 0)

        spans = pad_and_merge(self._speech(cfg.vad, samples), cfg.vad.paddingMs, end - start)
        ctx.check_cancelled()
        hints: list[str] | None = list(cfg.languageHints) if cfg.languageHints else None
        out_spans: list[TranscribeSpan] = []
        segments: list[TranscribeSegment] = []
        info = whisper_info(self._threads)
        if spans:
            try:
                engine = self._factory()
            except ModelUnavailable:
                raise TaskFailure(ErrorCode.UNSUPPORTED_TASK_TYPE) from None
            try:
                info = engine.info
                for n, (a, b) in enumerate(spans):
                    ctx.check_cancelled()
                    span, found = self._decode(engine, samples, start, a, b, hints=hints)
                    out_spans.append(span)
                    segments.extend(found)
                    ctx.report_progress("transcribe", (n + 1) / len(spans), b)
            except (TaskCancelled, TaskFailure):
                raise
            except Exception:  # noqa: BLE001 - engine failure: a code, never the message
                log.exception("transcribe_engine_failed", extra={"taskId": str(ctx.task_id)})
                raise TaskFailure(ErrorCode.INTERNAL_ERROR) from None
            finally:
                engine.close()
        ctx.report_progress("transcribe", 1.0, end - start)
        return TranscribeResult(
            schemaVersion=1,
            engine=info,
            vad=VadInfo(
                model=SILERO_VAD_V6_2_3.name, sha256=SILERO_VAD_V6_2_3.sha256, settings=cfg.vad
            ),
            window=MsRange(startMs=start, endMs=end),
            spans=out_spans,
            segments=segments,
            # No speech: whisper is not called at all (it invents text for silence).
            warnings=[] if spans else ["no_speech"],
        ).model_dump(mode="json")

    def _speech(self, settings: VadSettings, samples: np.ndarray) -> list[tuple[int, int]]:
        try:
            detector = self._detector(settings)
        except ModelUnavailable:
            raise TaskFailure(ErrorCode.UNSUPPORTED_TASK_TYPE) from None
        try:
            return detector.spans(samples)
        finally:
            detector.close()

    @staticmethod
    def _decode(  # noqa: PLR0913
        engine: SttEngine,
        samples: np.ndarray,
        window_start: int,
        a: int,
        b: int,
        *,
        hints: list[str] | None,
    ) -> tuple[TranscribeSpan, list[TranscribeSegment]]:
        """One speech span [a, b) (relative ms): its own language, then its segments."""
        clip = samples[a * SAMPLES_PER_MS : b * SAMPLES_PER_MS]
        detected, prob, probs = engine.detect(clip)
        decoded = choose_language(probs, hints)
        span = TranscribeSpan(
            startMs=window_start + a,
            endMs=window_start + b,
            detected=detected if detected and 2 <= len(detected) <= 8 else None,  # noqa: PLR2004
            probability=None if prob is None else min(1.0, max(0.0, prob)),
            decodedAs=decoded,
        )
        segments: list[TranscribeSegment] = []
        for rel_s, rel_e, text, token_prob in engine.transcribe(clip, decoded):
            s0 = window_start + a + max(0, rel_s)
            e0 = min(window_start + b, window_start + a + rel_e)
            if e0 <= s0:
                continue
            segments.append(
                TranscribeSegment(
                    startMs=s0,
                    endMs=e0,
                    text=text[:10_000],
                    language=decoded,
                    tokenProbability=None if token_prob is None else min(1.0, max(0.0, token_prob)),
                )
            )
        return span, segments
