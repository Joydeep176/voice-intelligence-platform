"""STT engines behind one tiny interface. Benchmark code only; not the production adapter.

Every engine receives float32 mono 16 kHz samples (at most 30 s) and returns text and, where the
model reports one, a language code. No VAD, no prompt, language auto-detected, greedy or default
decoding as noted per engine. Threads are set explicitly to the container CPU allowance.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .common import verified_model_path

CHUNK_S = 30.0


@dataclass
class Result:
    text: str
    lang: str | None


class Engine:
    name = ""
    detects_language = False

    def __init__(self, models: Path, threads: int) -> None:
        self.models = models
        self.threads = threads
        self.load_s = 0.0

    def load(self) -> None:
        t0 = time.perf_counter()
        self._load()
        self.load_s = time.perf_counter() - t0

    def _load(self) -> None:
        raise NotImplementedError

    def transcribe(self, x: np.ndarray) -> Result:
        raise NotImplementedError

    def model_files(self) -> list[Path]:
        raise NotImplementedError


class FasterWhisper(Engine):
    detects_language = True

    def __init__(self, models: Path, threads: int, size: str) -> None:
        super().__init__(models, threads)
        self.size = size
        self.name = f"faster-whisper-{size}-int8"
        self.model_id = f"fw-{size}"

    def model_files(self) -> list[Path]:
        return [
            verified_model_path(self.models, self.model_id, n)
            for n in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
        ]

    def _load(self) -> None:
        from faster_whisper import WhisperModel  # noqa: PLC0415

        folder = self.model_files()[0].parent  # all four files are hash-verified above
        self.model = WhisperModel(
            str(folder),
            device="cpu",
            compute_type="int8",
            cpu_threads=self.threads,
            num_workers=1,
            local_files_only=True,
        )

    def transcribe(self, x: np.ndarray) -> Result:
        segs, info = self.model.transcribe(
            x, language=None, beam_size=5, vad_filter=False, condition_on_previous_text=False
        )
        return Result(" ".join(s.text.strip() for s in segs), info.language)


class WhisperCpp(Engine):
    detects_language = True

    def __init__(self, models: Path, threads: int, size: str, quant: str) -> None:
        super().__init__(models, threads)
        self.name = f"whisper.cpp-{size}-{quant}"
        self.model_id = f"ggml-{size}-{quant}"
        self.file = f"ggml-{size}-{quant}.bin"

    def model_files(self) -> list[Path]:
        return [verified_model_path(self.models, self.model_id, self.file)]

    def _load(self) -> None:
        from pywhispercpp.model import Model  # noqa: PLC0415

        self.model = Model(
            str(self.model_files()[0]),
            n_threads=self.threads,
            print_progress=False,
            print_realtime=False,
            print_timestamps=False,
            language="auto",
        )

    def transcribe(self, x: np.ndarray) -> Result:
        # whisper.cpp detects the language in a separate encoder pass (what `-l auto` does
        # internally); doing it explicitly once gives the code and avoids a second detection.
        (lang, _prob), _all = self.model.auto_detect_language(x)
        segs = self.model.transcribe(x, language=lang, no_context=True)
        return Result(" ".join(s.text.strip() for s in segs), lang)


class SherpaWhisper(Engine):
    detects_language = True

    def __init__(self, models: Path, threads: int, size: str) -> None:
        super().__init__(models, threads)
        self.size = size
        self.name = f"sherpa-onnx-whisper-{size}-int8"
        self.model_id = f"sherpa-whisper-{size}"

    def model_files(self) -> list[Path]:
        s = self.size
        return [
            verified_model_path(self.models, self.model_id, f"{s}-encoder.int8.onnx"),
            verified_model_path(self.models, self.model_id, f"{s}-decoder.int8.onnx"),
            verified_model_path(self.models, self.model_id, f"{s}-tokens.txt"),
        ]

    def _load(self) -> None:
        import sherpa_onnx  # noqa: PLC0415

        enc, dec, tok = (str(p) for p in self.model_files())
        self.rec = sherpa_onnx.OfflineRecognizer.from_whisper(
            enc, dec, tok, language="", task="transcribe", num_threads=self.threads
        )

    def transcribe(self, x: np.ndarray) -> Result:
        stream = self.rec.create_stream()
        # The default cap (6 tokens per second) truncates Devanagari (Whisper needs many tokens per
        # second of Hindi); 15 is a benchmark setting, not a tuned value.
        stream.set_option("max_tokens_per_second", "15")
        stream.accept_waveform(16000, x)
        self.rec.decode_stream(stream)
        r = stream.result
        lang = getattr(r, "lang", None) or None
        if lang:
            lang = lang.strip("<|>")
        return Result(r.text, lang)


class SherpaOmni(Engine):
    name = "sherpa-onnx-omnilingual-300M-ctc-int8"
    model_id = "sherpa-omni-300m"

    def model_files(self) -> list[Path]:
        return [
            verified_model_path(self.models, self.model_id, "model.int8.onnx"),
            verified_model_path(self.models, self.model_id, "tokens.txt"),
        ]

    def _load(self) -> None:
        import sherpa_onnx  # noqa: PLC0415

        model, tokens = (str(p) for p in self.model_files())
        self.rec = sherpa_onnx.OfflineRecognizer.from_omnilingual_asr_ctc(
            model, tokens, num_threads=self.threads
        )

    def transcribe(self, x: np.ndarray) -> Result:
        stream = self.rec.create_stream()
        stream.accept_waveform(16000, x)
        self.rec.decode_stream(stream)
        return Result(stream.result.text, None)


ENGINE_IDS = [
    "fw-small",
    "fw-medium",
    "cpp-small",
    "cpp-medium",
    "sherpa-small",
    "sherpa-medium",
    "omni-300m",
]


def make_engine(engine_id: str, models: Path, threads: int) -> Engine:
    if engine_id.startswith("fw-"):
        return FasterWhisper(models, threads, engine_id[3:])
    if engine_id == "cpp-small":
        return WhisperCpp(models, threads, "small", "q5_1")
    if engine_id == "cpp-medium":
        return WhisperCpp(models, threads, "medium", "q5_0")
    if engine_id.startswith("sherpa-"):
        return SherpaWhisper(models, threads, engine_id[7:])
    if engine_id == "omni-300m":
        return SherpaOmni(models, threads)
    raise ValueError(engine_id)
