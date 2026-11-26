"""Self-checks of the M0 estimator code (run explicitly: `pytest benchmarks/quality`).

Not part of `pnpm audio:test` (testpaths is `tests`); they guard the benchmark's own definitions.
"""
# ruff: noqa: S101, PLR2004, E402

import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qbench import estimators as est

RNG = np.random.default_rng(7)


def _speech_like(n: int) -> np.ndarray:
    return RNG.gamma(0.4, 1.0, n) * RNG.choice((-1.0, 1.0), n)


def test_frame_power_and_mask() -> None:
    x = np.full(1600, 0.5)
    assert np.allclose(est.frame_power(x), 0.25)
    mask = est.spans_to_mask([(0, 25), (50, 60)], 10)
    assert mask.tolist() == [True, True, True, False, False, True, False, False, False, False]


def test_vad_split_snr_recovers_known_ratio() -> None:
    n_frames = 2000
    speech = np.zeros(n_frames, dtype=bool)
    speech[500:1500] = True
    noise_frames = ~speech
    s = np.zeros(n_frames * est.FRAME)
    s[500 * est.FRAME : 1500 * est.FRAME] = _speech_like(1000 * est.FRAME)
    s /= math.sqrt(np.mean(s[500 * est.FRAME : 1500 * est.FRAME] ** 2))
    noise = RNG.standard_normal(len(s)) * 10 ** (-10 / 20)  # 10 dB below speech
    r = est.vad_split_snr(est.frame_power(s + noise), speech, noise_frames)
    assert r["reason"] is None
    assert abs(r["value"] - 10.0) < 0.3


def test_vad_split_snr_reports_reasons_not_values() -> None:
    p = np.ones(10)
    none = np.zeros(10, dtype=bool)
    assert est.vad_split_snr(p, none, ~none)["reason"] == "no_speech"
    assert est.vad_split_snr(p, ~none, none)["reason"] == "no_noise_frames"
    assert est.vad_split_snr(np.zeros(10), ~none, ~none)["reason"] == "digital_silence"
    half = np.arange(10) < 5
    assert est.vad_split_snr(p, half, ~half)["reason"] == "non_positive"


def test_wada_table_rises_and_estimates_its_own_model() -> None:
    t = est.wada_table()
    assert t[-1] > t[0]
    n = 400_000
    speech = _speech_like(n)
    speech /= math.sqrt(np.mean(speech**2))
    for snr in (0, 10, 20):
        z = speech * 10 ** (snr / 20) + RNG.standard_normal(n)
        assert abs(est.wada_snr(z) - snr) < 1.5
    assert est.wada_snr(np.zeros(100)) is None


def test_bandwidth_estimators_follow_a_lowpass() -> None:
    x = RNG.standard_normal(16_000 * 4) * 0.1
    speech = np.ones(len(x) // est.FRAME, dtype=bool)
    full = est.speech_spectra(x, speech)
    lp = est.speech_spectra(est.quantise(est.lowpass(x, 3400)), speech)
    assert est.ltas_edge_hz(full) > 7800
    # Hann main-lobe leakage widens a brick-wall edge by about 2 bins (31.25 Hz each).
    assert 3300 <= est.ltas_edge_hz(lp) <= 3400 + 4 * 31.25
    assert est.rolloff_hz(lp) <= 3400 + 4 * 31.25 < est.rolloff_hz(full)
    assert est.rolloff_hz(np.zeros((0, 257))) is None


def test_block_snr_and_reference() -> None:
    frames = 300
    power = np.ones(frames)
    speech = np.zeros(frames, dtype=bool)
    speech[:200] = True
    power[:200] = 11.0  # speech + noise; noise power 1 -> 10 dB
    blocks = est.block_snr(power, speech, ~speech, 100)
    assert abs(blocks[0] - 10.0) < 1e-9
    assert blocks[2] is None  # no speech in the last block
    ref = est.block_reference_snr(np.full(frames, 10.0), np.ones(frames), speech, 100)
    assert abs(ref[0] - 10.0) < 1e-9
    assert ref[2] is None
