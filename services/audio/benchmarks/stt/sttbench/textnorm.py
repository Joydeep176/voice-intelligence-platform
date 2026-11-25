"""Documented text normalisation and edit-distance metrics (no transliteration, ever).

Normalisation, applied identically to references and hypotheses:
1. Unicode NFC (Devanagari is kept as is; nothing is transliterated or script-converted).
2. Lower-case (a no-op for Devanagari).
3. Apostrophes (' and U+2019) are deleted without a space ("don't" -> "dont").
4. Every other punctuation or symbol character (Unicode categories P* and S*, which includes the
   Devanagari danda U+0964) becomes a space, and format characters (Cf: ZWJ, ZWNJ) are deleted.
5. Whitespace is collapsed and trimmed.
Numerals are NOT converted: "nine" against "9" counts as an error, for every engine alike.
WER tokens are whitespace-separated. CER is over Unicode code points with spaces removed (a
combining Devanagari vowel sign counts as its own code point).
"""

from __future__ import annotations

import re
import unicodedata

_SPACE = re.compile(r"\s+")


def normalise(text: str) -> str:
    out: list[str] = []
    for ch in unicodedata.normalize("NFC", text).lower():
        cat = unicodedata.category(ch)
        if ch in "'’":
            continue
        if cat == "Cf":
            continue
        out.append(" " if cat[0] in "PS" else ch)
    return _SPACE.sub(" ", "".join(out)).strip()


def edit_distance(ref: list[str] | str, hyp: list[str] | str) -> int:
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1]


def word_errors(ref: str, hyp: str) -> tuple[int, int]:
    r, h = normalise(ref).split(), normalise(hyp).split()
    return edit_distance(r, h), len(r)


def char_errors(ref: str, hyp: str) -> tuple[int, int]:
    r, h = normalise(ref).replace(" ", ""), normalise(hyp).replace(" ", "")
    return edit_distance(r, h), len(r)
