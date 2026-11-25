"""Self-checks of the metric code (run explicitly: `pytest benchmarks/stt benchmarks/diarization`).

Not part of `pnpm audio:test` (testpaths is `tests`); they guard the benchmark's own definitions.
"""
# ruff: noqa: S101, PLR2004, E402

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "diarization"))

from diarbench.der import der
from sttbench.textnorm import char_errors, normalise, word_errors


def test_normalise_keeps_devanagari_and_strips_punctuation() -> None:
    assert normalise("Don't stop, now!") == "dont stop now"
    assert normalise("मैं घर जा रहा हूँ।") == "मैं घर जा रहा हूँ"
    assert normalise("यह  meeting\tकल है") == "यह meeting कल है"


def test_errors_count_edits() -> None:
    assert word_errors("the cat sat", "the cat sat") == (0, 3)
    assert word_errors("the cat sat", "the bat sat down") == (2, 3)
    assert char_errors("नमस्ते", "नमस्ते") == (0, 6)
    assert char_errors("abc", "abd")[0] == 1


def _seg(spk: str, a: float, b: float) -> dict[str, object]:
    return {"speaker": spk, "start": a, "end": b}


def test_der_perfect_and_label_permutation() -> None:
    ref = [_seg("a", 0, 10), _seg("b", 12, 20)]
    hyp = [_seg("x", 0, 10), _seg("y", 12, 20)]
    swapped = [_seg("y", 0, 10), _seg("x", 12, 20)]
    assert der(ref, hyp, 25)["der"] == 0.0
    assert der(ref, swapped, 25)["der"] == 0.0


def test_der_components() -> None:
    ref = [_seg("a", 0, 10)]
    assert abs(der(ref, [], 12, collar=0.0)["missed"] - 1.0) < 1e-9
    fa = der(ref, [_seg("x", 0, 10), _seg("x", 11, 12)], 12, collar=0.0)
    assert abs(fa["false_alarm"] - 0.1) < 1e-9
    conf = der([_seg("a", 0, 10)], [_seg("x", 0, 5), _seg("y", 5, 10)], 10, collar=0.0)
    assert abs(conf["confusion"] - 0.5) < 1e-9


def test_der_collar_excludes_boundaries() -> None:
    ref = [_seg("a", 0, 10)]
    hyp = [_seg("x", 0.2, 9.8)]
    assert der(ref, hyp, 10, collar=0.0)["missed"] > 0
    assert der(ref, hyp, 10, collar=0.25)["der"] == 0.0
