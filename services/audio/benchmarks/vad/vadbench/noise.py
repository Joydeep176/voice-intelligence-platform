"""Seeded synthetic noise generators (NumPy only). Every generator returns unit-RMS float64."""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from .common import SAMPLE_RATE

Array = np.ndarray


def _unit_rms(x: Array) -> Array:
    rms = float(np.sqrt(np.mean(x * x)))
    return x / rms if rms > 0 else x


def _shaped(n: int, rng: np.random.Generator, exponent: float) -> Array:
    """White noise filtered in the frequency domain to a 1/f**exponent amplitude slope."""
    spectrum = np.fft.rfft(rng.standard_normal(n))
    freqs = np.fft.rfftfreq(n, 1.0 / SAMPLE_RATE)
    spectrum[1:] /= freqs[1:] ** exponent
    spectrum[0] = 0.0
    return _unit_rms(np.fft.irfft(spectrum, n))


def white(n: int, rng: np.random.Generator) -> Array:
    return _unit_rms(rng.standard_normal(n))


def pink(n: int, rng: np.random.Generator) -> Array:
    return _shaped(n, rng, 0.5)  # power ~ 1/f


def brown(n: int, rng: np.random.Generator) -> Array:
    return _shaped(n, rng, 1.0)  # power ~ 1/f**2


def hum(n: int, rng: np.random.Generator) -> Array:
    """50 Hz mains hum with eight harmonics (amplitude 1/k, random phases)."""
    t = np.arange(n) / SAMPLE_RATE
    out = np.zeros(n)
    for k in range(1, 9):
        out += np.sin(2 * np.pi * 50.0 * k * t + rng.uniform(0, 2 * np.pi)) / k
    return _unit_rms(out)


def am_pink(n: int, rng: np.random.Generator) -> Array:
    """Pink noise whose amplitude is modulated by a slow sinusoid (0.4 to 2.5 Hz, depth 0.8)."""
    t = np.arange(n) / SAMPLE_RATE
    modulation = 0.55 + 0.45 * np.sin(2 * np.pi * rng.uniform(0.4, 2.5) * t + rng.uniform(0, 6.28))
    return _unit_rms(pink(n, rng) * modulation)


def clicks(n: int, rng: np.random.Generator) -> Array:
    """Poisson impulses (about 4 per second): decaying 3-12 ms noise bursts over a faint floor."""
    out = 0.01 * rng.standard_normal(n)
    count = max(1, int(4 * n / SAMPLE_RATE))
    starts = rng.integers(0, max(1, n - 400), size=count)
    for start in starts:
        length = int(rng.uniform(0.003, 0.012) * SAMPLE_RATE)
        decay = np.exp(-np.arange(length) / (0.35 * length))
        out[start : start + length] += (
            rng.lognormal(0.0, 0.6) * decay * rng.standard_normal(length)
        )[: n - start]
    return _unit_rms(out)


_NOTES_HZ = [130.8, 146.8, 164.8, 196.0, 220.0, 261.6, 293.7, 329.6, 392.0, 440.0]


def music(n: int, rng: np.random.Generator) -> Array:
    """Tonal bed: 1.5 to 3 s chords of three pentatonic notes (four harmonics), 80 ms crossfades."""
    out = np.zeros(n)
    fade = int(0.08 * SAMPLE_RATE)
    pos = 0
    while pos < n:
        length = int(rng.uniform(1.5, 3.0) * SAMPLE_RATE)
        end = min(n, pos + length + fade)
        t = np.arange(end - pos) / SAMPLE_RATE
        chord = np.zeros(end - pos)
        for note in rng.choice(_NOTES_HZ, size=3, replace=False):
            for h in range(1, 5):
                chord += np.sin(2 * np.pi * note * h * t + rng.uniform(0, 6.28)) / h
        env = np.ones(end - pos)
        m = min(fade, end - pos)
        env[:m] = np.linspace(0, 1, m)
        env[-m:] = np.minimum(env[-m:], np.linspace(1, 0, m))
        out[pos:end] += chord * env
        pos += length
    return _unit_rms(out)


GENERATORS: dict[str, Callable[[int, np.random.Generator], Array]] = {
    "white": white,
    "pink": pink,
    "brown": brown,
    "hum": hum,
    "am_pink": am_pink,
    "clicks": clicks,
    "music": music,
}
