"""The three VAD candidates behind one streaming interface.

`feed(chunk)` takes int16 samples (a multiple of 15,360, the lcm of every candidate frame) and
returns a `(channels, frames)` float array with one column per 10 ms reference frame. State carries
across `feed` calls, so a long file streamed in chunks equals the same file in one call.
`decide(...)` turns scores into the boolean 10 ms speech mask for one parameter setting.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from . import common as c

Array = np.ndarray
ALIGN = 15_360

SILERO_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"
SILERO_FRAME = 512
SILERO_CONTEXT = 64


class SileroDetector:
    name = "silero"

    def __init__(self, model_path: Path) -> None:
        import onnxruntime as ort  # noqa: PLC0415

        digest = c.sha256_file(model_path)
        if digest != SILERO_SHA256:
            raise RuntimeError(f"Silero model SHA-256 mismatch: {digest}")
        ort.disable_telemetry_events()
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self._session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self._sr = np.array(c.SAMPLE_RATE, dtype=np.int64)
        self.reset()

    def reset(self) -> None:
        self._state = np.zeros((2, 1, 128), dtype=np.float32)
        self._context = np.zeros((1, SILERO_CONTEXT), dtype=np.float32)

    def feed(self, chunk: Array) -> Array:
        x = chunk.astype(np.float32) / 32768.0
        probs = np.empty(len(x) // SILERO_FRAME, dtype=np.float32)
        for j in range(len(probs)):
            frame = x[j * SILERO_FRAME : (j + 1) * SILERO_FRAME][None, :]
            inp = np.concatenate([self._context, frame], axis=1)
            out, self._state = self._session.run(
                None, {"input": inp, "state": self._state, "sr": self._sr}
            )
            self._context = inp[:, -SILERO_CONTEXT:]
            probs[j] = out[0, 0]
        # 10 ms frame k is scored by the Silero frame that contains its centre sample.
        k = np.arange(len(chunk) // c.FRAME)
        return probs[(k * c.FRAME + c.FRAME // 2) // SILERO_FRAME][None, :].astype(np.float64)


class WebRtcDetector:
    def __init__(self, mode: int, frame_ms: int) -> None:
        import webrtcvad  # noqa: PLC0415

        self.name = "webrtc"
        self._mode = mode
        self._ms = frame_ms
        self._lib = webrtcvad
        self.reset()

    def reset(self) -> None:
        self._vad = self._lib.Vad(self._mode)

    def feed(self, chunk: Array) -> Array:
        step = self._ms * c.SAMPLE_RATE // 1000
        raw = chunk.astype("<i2").tobytes()
        decisions = np.fromiter(
            (
                self._vad.is_speech(raw[i * 2 : (i + step) * 2], c.SAMPLE_RATE)
                for i in range(0, len(chunk), step)
            ),
            dtype=np.float64,
        )
        return np.repeat(decisions, self._ms // 10)[None, :]


class BaselineDetector:
    """Energy + spectral flatness + adaptive noise floor (decision and hangover in `decide`).

    Causal 25 ms Hann window ending at the end of each 10 ms frame. Noise floor in dB: falls quickly
    to any lower frame energy (rate 0.2) and rises slowly (rate 0.01) only when the frame is within
    6 dB of it, so speech does not drag it up. Features: excess = energy - floor (dB) and the
    spectral flatness of 100-4000 Hz.
    """

    name = "baseline"
    WINDOW = 400
    NFFT = 512

    def __init__(self) -> None:
        self._win = np.hanning(self.WINDOW)
        self.reset()

    def reset(self) -> None:
        self._history = np.zeros(self.WINDOW - c.FRAME, dtype=np.float64)
        self._floor: float | None = None

    def feed(self, chunk: Array) -> Array:
        x = np.concatenate([self._history, chunk.astype(np.float64) / 32768.0])
        self._history = x[-(self.WINDOW - c.FRAME) :]
        windows = np.lib.stride_tricks.sliding_window_view(x, self.WINDOW)[:: c.FRAME]
        energy = 10 * np.log10(np.mean(windows * windows, axis=1) + 1e-12)
        power = np.abs(np.fft.rfft(windows * self._win, n=self.NFFT, axis=1)) ** 2 + 1e-12
        band = power[:, 6:128]  # about 94-4000 Hz at 31.25 Hz per bin
        flatness = np.exp(np.mean(np.log(band), axis=1)) / np.mean(band, axis=1)
        excess = np.empty_like(energy)
        floor = energy[0] if self._floor is None else self._floor
        for i, e in enumerate(energy.tolist()):
            if e < floor:
                floor += 0.2 * (e - floor)
            elif e - floor < 6.0:
                floor += 0.01 * (e - floor)
            excess[i] = e - floor
        self._floor = floor
        return np.stack([excess, flatness])


def run_chunked(detector: Any, audio: Array) -> Array:
    """Score a whole signal from a fresh state; the tail is zero-padded and then truncated."""
    detector.reset()
    n_frames = len(audio) // c.FRAME
    parts = []
    for start in range(0, len(audio), c.CHUNK_SAMPLES):
        chunk = audio[start : start + c.CHUNK_SAMPLES]
        pad = (-len(chunk)) % ALIGN
        if pad:
            chunk = np.concatenate([chunk, np.zeros(pad, dtype=chunk.dtype)])
        parts.append(detector.feed(chunk))
    return np.concatenate(parts, axis=1)[:, :n_frames]


HANGOVER_FRAMES = 8


def hangover(raw: Array, frames: int = HANGOVER_FRAMES) -> Array:
    idx = np.where(raw, np.arange(len(raw)), -(10**9))
    last = np.maximum.accumulate(idx)
    return (np.arange(len(raw)) - last) <= frames


def decide(candidate: str, scores: Array, params: dict[str, Any]) -> Array:
    if candidate == "silero":
        return scores[0] > params["threshold"]
    if candidate == "webrtc":
        return scores[0] > 0.5
    if candidate == "baseline":
        raw = (scores[0] > params["excess_db"]) & (scores[1] < params["flatness_max"])
        return hangover(raw)
    raise ValueError(candidate)


def grid(candidate: str) -> list[dict[str, Any]]:
    if candidate == "silero":
        return [{"threshold": round(0.1 + 0.05 * i, 2)} for i in range(17)]
    if candidate == "webrtc":
        return [{"mode": m, "frame_ms": f} for m in range(4) for f in (10, 20, 30)]
    if candidate == "baseline":
        return [
            {"excess_db": t, "flatness_max": f}
            for t in (1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 12.0, 15.0)
            for f in (0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 2.0)
        ]
    raise ValueError(candidate)


def make_detector(candidate: str, params: dict[str, Any], models_dir: Path) -> Any:
    if candidate == "silero":
        return SileroDetector(models_dir / "silero_vad.onnx")
    if candidate == "webrtc":
        return WebRtcDetector(params["mode"], params["frame_ms"])
    if candidate == "baseline":
        return BaselineDetector()
    raise ValueError(candidate)


def scoring_key(candidate: str, params: dict[str, Any]) -> tuple[Any, ...]:
    """Parameters that change the *scores* (so scores can be reused across the rest)."""
    if candidate == "webrtc":
        return (params["mode"], params["frame_ms"])
    return ()
