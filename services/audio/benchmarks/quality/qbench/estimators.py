"""Candidate A1 Tier 1 estimators (Phase 3A M0, benchmark only; NumPy only, no VAD here).

These are prototypes of the measurements the future `measure` task would compute (ADR-0045,
Proposed). They are numbers only: no thresholds, classes or judgements. Signals are float64 in
full-scale units ([-1, 1)) at 16 kHz; a "frame" is 10 ms (160 samples).
"""

from __future__ import annotations

import math

import numpy as np

SAMPLE_RATE = 16_000
FRAME = 160  # 10 ms
FFT_SIZE = 512  # 32 ms, Silero's window
EPS_POWER = 1e-20

Array = np.ndarray


def frame_power(x: Array) -> Array:
    """Mean square per complete 10 ms frame (float64)."""
    n = len(x) // FRAME
    frames = x[: n * FRAME].reshape(n, FRAME)
    return np.einsum("ij,ij->i", frames, frames) / FRAME


def spans_to_mask(spans_ms: list[tuple[int, int]], n_frames: int) -> Array:
    """10 ms frame mask from half-open millisecond spans."""
    mask = np.zeros(n_frames, dtype=bool)
    for start, end in spans_ms:
        a, b = max(0, start // 10), min(n_frames, -(-end // 10))
        if b > a:
            mask[a:b] = True
    return mask


def to_db(ratio: float) -> float:
    return 10.0 * math.log10(ratio)


def vad_split_snr(power: Array, speech: Array, noise: Array) -> dict[str, float | int | str | None]:
    """SNR from a speech / non-speech split (power subtraction).

    `speech` frames carry speech + noise; `noise` frames carry noise only (frames outside the padded
    spans, so speech onsets do not leak in). Estimate = 10 log10((Ps - Pn) / Pn). Returns the value
    or `None` with a reason; never a guess.
    """
    n_s, n_n = int(speech.sum()), int(noise.sum())
    if n_s == 0:
        return {"value": None, "reason": "no_speech", "speechFrames": 0, "noiseFrames": n_n}
    if n_n == 0:
        return {"value": None, "reason": "no_noise_frames", "speechFrames": n_s, "noiseFrames": 0}
    ps, pn = float(power[speech].mean()), float(power[noise].mean())
    if pn <= EPS_POWER:
        return {"value": None, "reason": "digital_silence", "speechFrames": n_s, "noiseFrames": n_n}
    if ps <= pn:
        return {"value": None, "reason": "non_positive", "speechFrames": n_s, "noiseFrames": n_n}
    return {"value": to_db((ps - pn) / pn), "reason": None, "speechFrames": n_s, "noiseFrames": n_n}


def vad_split_snr_robust(
    power: Array, speech: Array, noise: Array, percentile: float = 20.0
) -> dict[str, float | int | str | None]:
    """Variant: noise power = a low percentile of noise-frame powers (resists speech leaking into
    noise frames when the VAD misses speech); speech power = mean of speech frames minus it."""
    n_s, n_n = int(speech.sum()), int(noise.sum())
    if n_s == 0 or n_n == 0:
        return {"value": None, "reason": "no_speech" if n_s == 0 else "no_noise_frames"}
    pn = float(np.percentile(power[noise], percentile))
    ps = float(power[speech].mean())
    if pn <= EPS_POWER:
        return {"value": None, "reason": "digital_silence"}
    if ps <= pn:
        return {"value": None, "reason": "non_positive"}
    return {"value": to_db((ps - pn) / pn), "reason": None}


# -- WADA-SNR (Kim & Stern, Interspeech 2008), secondary baseline ----------------------------------

WADA_DB = np.arange(-20, 101, dtype=np.float64)
_WADA_TABLE: Array | None = None


def wada_table(alpha: float = 0.4, n: int = 2_000_000, seed: int = 20_261_126) -> Array:
    """G(SNR) = log E|z| - E log|z| for z = gamma(alpha)-amplitude speech + Gaussian noise.

    Re-derived by seeded Monte Carlo from the paper's model (the original lookup table is not
    vendored), so the baseline is deterministic and dependency-free.
    """
    global _WADA_TABLE  # noqa: PLW0603
    if _WADA_TABLE is None:
        rng = np.random.default_rng(seed)
        speech = rng.gamma(alpha, 1.0, n) * rng.choice((-1.0, 1.0), n)
        speech /= math.sqrt(float(np.mean(speech * speech)))
        noise = rng.standard_normal(n)
        noise /= math.sqrt(float(np.mean(noise * noise)))
        out = np.empty(len(WADA_DB))
        for i, db in enumerate(WADA_DB):
            z = np.abs(speech * 10 ** (db / 20) + noise)
            np.maximum(z, 1e-10, out=z)
            out[i] = math.log(float(z.mean())) - float(np.log(z).mean())
        _WADA_TABLE = out
    return _WADA_TABLE


def wada_snr(x: Array) -> float | None:
    """WADA-SNR estimate in dB (clamped to the table range), `None` for digital silence."""
    a = np.abs(x)
    if float(a.max(initial=0.0)) == 0.0:
        return None
    np.maximum(a, 1e-10, out=a)
    g = math.log(float(a.mean())) - float(np.log(a).mean())
    table = wada_table()
    # G rises with SNR; Monte Carlo noise can make the plateau slightly non-monotone, so interpolate
    # over the pairs sorted by G.
    order = np.argsort(table)
    return float(np.interp(g, table[order], WADA_DB[order]))


# -- bandwidth ------------------------------------------------------------------------------------


def speech_spectra(x: Array, speech: Array) -> Array:
    """Power spectra (Hann, 512) of non-overlapping 32 ms frames lying fully in speech frames."""
    hop = FFT_SIZE
    win = np.hanning(FFT_SIZE)
    rows = []
    for start in range(0, len(x) - FFT_SIZE + 1, hop):
        f0, f1 = start // FRAME, (start + FFT_SIZE - 1) // FRAME
        if f1 < len(speech) and speech[f0 : f1 + 1].all():
            rows.append(np.abs(np.fft.rfft(x[start : start + FFT_SIZE] * win)) ** 2)
    return np.array(rows) if rows else np.zeros((0, FFT_SIZE // 2 + 1))


def rolloff_hz(spectra: Array, fraction: float = 0.99) -> float | None:
    """Median over frames of the frequency below which `fraction` of the frame energy lies."""
    if len(spectra) == 0:
        return None
    freqs = np.fft.rfftfreq(FFT_SIZE, 1 / SAMPLE_RATE)
    cum = np.cumsum(spectra, axis=1)
    total = cum[:, -1:]
    valid = total[:, 0] > 0
    if not valid.any():
        return None
    idx = np.argmax(cum[valid] >= fraction * total[valid], axis=1)
    return float(np.median(freqs[idx]))


def ltas_edge_hz(spectra: Array, drop_db: float = 50.0, min_hz: float = 300.0) -> float | None:
    """Highest frequency whose long-term average spectrum is within `drop_db` of its maximum
    (maximum taken above `min_hz`)."""
    if len(spectra) == 0:
        return None
    freqs = np.fft.rfftfreq(FFT_SIZE, 1 / SAMPLE_RATE)
    ltas = spectra.mean(axis=0)
    ref = float(ltas[freqs >= min_hz].max())
    if ref <= 0:
        return None
    above = np.flatnonzero(10 * np.log10(np.maximum(ltas, EPS_POWER) / ref) >= -drop_db)
    return float(freqs[above[-1]])


def lowpass(x: Array, cutoff_hz: float) -> Array:
    """Brick-wall low-pass in the frequency domain (test-signal construction only)."""
    spec = np.fft.rfft(x)
    spec[np.fft.rfftfreq(len(x), 1 / SAMPLE_RATE) > cutoff_hz] = 0
    return np.fft.irfft(spec, len(x))


def quantise(x: Array) -> Array:
    """Round to int16 and back to full-scale float64 (what a stored WAV would hold)."""
    return np.clip(np.rint(x * 32768.0), -32768, 32767) / 32768.0


# -- blocks ---------------------------------------------------------------------------------------


def block_snr(  # noqa: PLR0913
    power: Array,
    speech: Array,
    noise: Array,
    block_frames: int,
    *,
    min_speech_share: float = 0.25,
    min_noise_share: float = 0.2,
) -> list[float | None]:
    """Per-block SNR estimate: speech power in the block minus a noise power that is local when the
    block has enough non-speech frames, else the file-level noise power. `None` = not estimable."""
    pn_file = float(power[noise].mean()) if noise.any() else None
    out: list[float | None] = []
    for b in range(0, len(power) // block_frames):
        sl = slice(b * block_frames, (b + 1) * block_frames)
        s, n = speech[sl], noise[sl]
        if s.mean() < min_speech_share:
            out.append(None)
            continue
        pn = float(power[sl][n].mean()) if n.mean() >= min_noise_share else pn_file
        ps = float(power[sl][s].mean())
        out.append(to_db((ps - pn) / pn) if pn and pn > EPS_POWER and ps > pn else None)
    return out


def block_reference_snr(
    clean_power: Array, noise_power: Array, ref: Array, block_frames: int, min_share: float = 0.25
) -> list[float | None]:
    """Per-block active-speech SNR from the true components over reference speech frames."""
    out: list[float | None] = []
    for b in range(0, len(ref) // block_frames):
        sl = slice(b * block_frames, (b + 1) * block_frames)
        r = ref[sl]
        if r.mean() < min_share:
            out.append(None)
            continue
        cp, npow = float(clean_power[sl][r].mean()), float(noise_power[sl][r].mean())
        out.append(to_db(cp / npow) if npow > EPS_POWER and cp > 0 else None)
    return out


# -- fragmentation --------------------------------------------------------------------------------


def spans_per_window(
    spans_by_window: list[list[tuple[int, int]]],
) -> dict[str, float | int]:
    counts = [len(s) for s in spans_by_window]
    return {
        "windows": len(counts),
        "max": max(counts, default=0),
        "mean": float(np.mean(counts)) if counts else 0.0,
    }
