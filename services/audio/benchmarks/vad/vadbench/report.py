"""Merge stage outputs into results.json, the generated tables and the plan 13.4 criteria table.

The criteria are applied mechanically and reported as input to the user's decision; nothing here
selects a candidate.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from . import common as c

CANDIDATES = ["silero", "webrtc", "baseline"]
LABEL = {"silero": "Silero (ONNX)", "webrtc": "WebRTC", "baseline": "NumPy baseline"}
LANGS = ["english", "hindi", "hinglish", "all"]
SNR_KEYS = ["clean", "20", "10", "5", "0", "all"]


def _row(rows: list[dict[str, Any]], lang: str, noise: str, snr: str) -> dict[str, Any]:
    for r in rows:
        if (r["language"], r["noise"], r["snr"]) == (lang, noise, snr):
            return r
    raise KeyError((lang, noise, snr))


def _f(v: float | None, digits: int = 3) -> str:
    return "n/a" if v is None else f"{v:.{digits}f}"


def _md(headers: list[str], body: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    out += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(out)


def criteria(data: dict[str, Any]) -> dict[str, Any]:
    ev, res, det = data["evaluation"], data["resources"], data["determinism"]
    out: dict[str, Any] = {}
    for cand in CANDIDATES:
        rows = ev[cand]["rows"]
        base = data["evaluation"]["baseline"]["rows"]
        cells = []
        worst_cells = []
        for lang in c.LANGUAGES:
            for snr in ("10", "5"):
                f1 = {k: _row(ev[k]["rows"], lang, "all", snr)["f1"] for k in CANDIDATES}
                cells.append((lang, snr, f1[cand]))
                others = [v for k, v in f1.items() if k != cand]
                if f1[cand] < min(others):
                    worst_cells.append(f"{lang}@{snr}dB")
        guards = {}
        guard_ok = True
        for snr in ("10", "5"):
            mine, ref = _row(rows, "all", "all", snr), _row(base, "all", "all", snr)
            fpr_ok = mine["fpr"] <= ref["fpr"]
            nsi_ok = mine["nonspeech_inclusion"] <= ref["nonspeech_inclusion"]
            guards[snr] = {
                "fpr": mine["fpr"],
                "baseline_fpr": ref["fpr"],
                "fpr_ok": fpr_ok,
                "nsi": mine["nonspeech_inclusion"],
                "baseline_nsi": ref["nonspeech_inclusion"],
                "nsi_ok": nsi_ok,
            }
            guard_ok = guard_ok and fpr_ok and nsi_ok
        per_lang_ok = sum(
            _row(rows, lang, "all", snr)["fpr"] <= _row(base, lang, "all", snr)["fpr"]
            and _row(rows, lang, "all", snr)["nonspeech_inclusion"]
            <= _row(base, lang, "all", snr)["nonspeech_inclusion"]
            for lang in c.LANGUAGES
            for snr in ("10", "5")
        )
        r = res[cand]
        out[cand] = {
            "memory_peak_mib": r["memory_peak_mib"],
            "memory_ok": r["memory_peak_mib"] is not None
            and r["memory_peak_mib"] <= c.MEMORY_GATE_MB,
            "rtf_median": r["rtf_median"],
            "rtf_ok": r["rtf_median"] <= c.RTF_LIMIT,
            "deterministic": det[cand]["identical"],
            "licence_clean": True,
            "hard_ok": all(
                [
                    r["memory_peak_mib"] is not None and r["memory_peak_mib"] <= c.MEMORY_GATE_MB,
                    r["rtf_median"] <= c.RTF_LIMIT,
                    det[cand]["identical"],
                ]
            ),
            "worst_cells": worst_cells,
            "quality_ok": not worst_cells,
            "f1_cells": [{"language": a, "snr": b, "f1": v} for a, b, v in cells],
            "guards": guards,
            "guards_ok": guard_ok,
            "guards_per_language_cells_ok": f"{per_lang_ok}/6",
        }
    return out


def headline(data: dict[str, Any]) -> str:
    body = []
    for lang in c.LANGUAGES:
        for snr in ("10", "5"):
            row = [lang, f"{snr} dB"]
            for cand in CANDIDATES:
                r = _row(data["evaluation"][cand]["rows"], lang, "all", snr)
                row += [_f(r["f1"]), _f(r["fpr"]), _f(r["nonspeech_inclusion"])]
            body.append(row)
    headers = ["Language", "SNR"] + [
        f"{LABEL[k]} {m}" for k in CANDIDATES for m in ("F1", "FPR", "NSI")
    ]
    return _md(headers, body)


def overall_by_snr(data: dict[str, Any]) -> str:
    body = []
    for snr in SNR_KEYS:
        for cand in CANDIDATES:
            r = _row(data["evaluation"][cand]["rows"], "all", "all", snr)
            body.append(
                [
                    snr,
                    LABEL[cand],
                    _f(r["precision"]),
                    _f(r["recall"]),
                    _f(r["fpr"]),
                    _f(r["fnr"]),
                    _f(r["f1"]),
                    _f(r["onset_abs_median_ms"], 0),
                    _f(r["onset_abs_p95_ms"], 0),
                    _f(r["offset_abs_median_ms"], 0),
                    _f(r["offset_abs_p95_ms"], 0),
                    _f(r["speech_coverage"]),
                    _f(r["nonspeech_inclusion"]),
                    _f(r["missed_utterance_rate"]),
                ]
            )
    headers = [
        "SNR",
        "Candidate",
        "Prec",
        "Recall",
        "FPR",
        "FNR",
        "F1",
        "Onset med ms",
        "Onset p95 ms",
        "Offset med ms",
        "Offset p95 ms",
        "Coverage",
        "NSI",
        "Missed utt.",
    ]
    return _md(headers, body)


def tuning_table(data: dict[str, Any]) -> str:
    body = []
    for cand in CANDIDATES:
        t = data["tuning"][cand]
        body.append([LABEL[cand], str(t["selected"]), _f(t["objective"], 4), str(len(t["grid"]))])
    return _md(
        ["Candidate", "Selected on dev", "Dev objective (mean F1 at 10/5 dB)", "Grid size"], body
    )


def resource_table(data: dict[str, Any]) -> str:
    body = []
    for cand in CANDIDATES:
        r = data["resources"][cand]
        body.append(
            [
                LABEL[cand],
                _f(r["rtf_median"], 5),
                _f(r["cpu_s_per_audio_hour_median"], 1),
                _f(r["memory_peak_mib"], 1),
                _f(r["anon_max_sampled_mib"], 1),
                _f(r["anon_first_third_max_mib"], 1),
                _f(r["anon_last_third_max_mib"], 1),
                _f(r["file_cache_final_mib"], 1),
            ]
        )
    headers = [
        "Candidate",
        "RTF (median of 3)",
        "CPU s / audio hour",
        "memory.peak MiB",
        "anon max MiB (sampled)",
        "anon first third max",
        "anon last third max",
        "file cache MiB (end)",
    ]
    return _md(headers, body)


def drift_table(data: dict[str, Any]) -> str:
    body = []
    for cand in CANDIDATES:
        for lf in data["drift"][cand]["long_files"]:
            body.append(
                [
                    LABEL[cand],
                    lf["id"],
                    f"{lf['duration_min']:.1f}",
                    _f(lf["f1_first_block"]),
                    _f(lf["f1_last_full_block"]),
                    _f(lf["f1_min_block"]),
                    _f(lf["f1_max_block"]),
                    f"{lf['frames_differing_from_per_mixture_scoring']} / {lf['frames_total']}",
                ]
            )
    headers = [
        "Candidate",
        "File",
        "Minutes",
        "F1 first 10 min",
        "F1 last full block",
        "F1 min block",
        "F1 max block",
        "Frames differing from per-mixture scoring",
    ]
    return _md(headers, body)


def determinism_table(data: dict[str, Any]) -> str:
    body = [
        [LABEL[k], v["decisions_sha256"][:16], "yes" if v["identical"] else "NO"]
        for k, v in data["determinism"].items()
    ]
    return _md(
        [
            "Candidate",
            "Test decisions SHA-256 (prefix), runs a and b",
            "Identical decisions and metrics",
        ],
        body,
    )


def criteria_table(crit: dict[str, Any]) -> str:
    def yn(v: bool) -> str:
        return "meets" if v else "FAILS"

    body = []
    for cand in CANDIDATES:
        x = crit[cand]
        g = x["guards"]
        body.append(
            [
                LABEL[cand],
                f"{yn(x['memory_ok'])} ({_f(x['memory_peak_mib'], 1)} MiB peak)",
                f"{yn(x['rtf_ok'])} (RTF {_f(x['rtf_median'], 5)})",
                yn(x["deterministic"]),
                "meets (MIT / BSD / project code)",
                f"{yn(x['quality_ok'])}"
                + ("" if x["quality_ok"] else f" (worst in {', '.join(x['worst_cells'])})"),
                f"{yn(x['guards_ok'])} (FPR {_f(g['10']['fpr'])}/{_f(g['5']['fpr'])} vs "
                f"{_f(g['10']['baseline_fpr'])}/{_f(g['5']['baseline_fpr'])}; NSI "
                f"{_f(g['10']['nsi'])}/{_f(g['5']['nsi'])} vs "
                f"{_f(g['10']['baseline_nsi'])}/{_f(g['5']['baseline_nsi'])}; per-language cells "
                f"{x['guards_per_language_cells_ok']})",
            ]
        )
    headers = [
        "Candidate",
        "1a Memory gate",
        "1b RTF <= 0.05",
        "1c Deterministic",
        "1d Licence",
        "2 Not worst in any language at 10/5 dB",
        "3 FPR and NSI <= baseline at 10 / 5 dB",
    ]
    return _md(headers, body)


def full_tables(data: dict[str, Any]) -> str:
    parts = [
        "# VAD benchmark: full test-split tables (generated)\n",
        "Per language x noise type x SNR (`all` = pooled). Frame metrics are 10 ms; "
        "boundary errors are absolute ms on unpadded segments; "
        "coverage and NSI are on padded segments. "
        "See README.md for definitions.\n",
    ]
    headers = [
        "Language",
        "Noise",
        "SNR",
        "Mixtures",
        "Prec",
        "Recall",
        "FPR",
        "FNR",
        "F1",
        "On med",
        "On p95",
        "Off med",
        "Off p95",
        "Coverage",
        "NSI",
        "Missed",
    ]
    for cand in CANDIDATES:
        ev = data["evaluation"][cand]
        parts.append(f"\n## {LABEL[cand]}: {ev['params']}\n")
        body = []
        for r in ev["rows"]:
            body.append(
                [
                    r["language"],
                    r["noise"],
                    r["snr"],
                    str(r["mixtures"]),
                    _f(r["precision"]),
                    _f(r["recall"]),
                    _f(r["fpr"]),
                    _f(r["fnr"]),
                    _f(r["f1"]),
                    _f(r["onset_abs_median_ms"], 0),
                    _f(r["onset_abs_p95_ms"], 0),
                    _f(r["offset_abs_median_ms"], 0),
                    _f(r["offset_abs_p95_ms"], 0),
                    _f(r["speech_coverage"]),
                    _f(r["nonspeech_inclusion"]),
                    _f(r["missed_utterance_rate"]),
                ]
            )
        parts.append(_md(headers, body))
    return "\n".join(parts) + "\n"


def _fill(text: str, name: str, content: str) -> str:
    pat = re.compile(rf"(<!-- BEGIN:{name} -->\n).*?(<!-- END:{name} -->)", re.DOTALL)
    if not pat.search(text):
        raise KeyError(name)
    body = content if content.endswith("\n") else content + "\n"
    return pat.sub(lambda m: m.group(1) + body + m.group(2), text)


def build(results: Path, docs: Path) -> None:
    data: dict[str, Any] = {
        "tuning": {},
        "evaluation": {},
        "drift": {},
        "resources": {},
        "determinism": {},
    }
    for cand in CANDIDATES:
        data["tuning"][cand] = c.read_json(results / f"tuning-{cand}.json")
        a = c.read_json(results / f"evaluation-{cand}-a.json")
        b = c.read_json(results / f"evaluation-{cand}-b.json")
        data["evaluation"][cand] = a
        data["determinism"][cand] = {
            "decisions_sha256": a["decisions_sha256"],
            "decisions_sha256_run_b": b["decisions_sha256"],
            "metrics_sha256": a["metrics_sha256"],
            "metrics_sha256_run_b": b["metrics_sha256"],
            "identical": a["decisions_sha256"] == b["decisions_sha256"]
            and a["metrics_sha256"] == b["metrics_sha256"],
        }
        data["drift"][cand] = c.read_json(results / f"drift-{cand}.json")
        data["resources"][cand] = c.read_json(results / f"resources-{cand}.json")
    crit = criteria(data)
    manifest = c.read_json(docs / "corpus-manifest.json")
    out = {
        "note": "Synthetic TTS corpus; measured numbers only; no candidate is selected here.",
        "benchmark_settings": {
            "min_speech_ms": c.MIN_SPEECH_FRAMES * 10,
            "min_silence_ms": c.MIN_SILENCE_FRAMES * 10,
            "padding_ms": c.PAD_FRAMES * 10,
            "rtf_limit": c.RTF_LIMIT,
            "memory_gate_mib": c.MEMORY_GATE_MB,
        },
        "corpus": {
            "seed": manifest["seed"],
            "environment": manifest["environment"],
            "manifest": "corpus-manifest.json",
        },
        "criteria_13_4": crit,
        **data,
    }
    c.write_json(docs / "results.json", out)
    (docs / "results-tables.md").write_text(full_tables(data), encoding="utf-8")
    readme = docs / "README.md"
    text = readme.read_text(encoding="utf-8")
    for name, content in [
        ("tuning", tuning_table(data)),
        ("headline", headline(data)),
        ("overall", overall_by_snr(data)),
        ("resources", resource_table(data)),
        ("drift", drift_table(data)),
        ("determinism", determinism_table(data)),
        ("criteria", criteria_table(crit)),
    ]:
        text = _fill(text, name, content)
    readme.write_text(text, encoding="utf-8")
