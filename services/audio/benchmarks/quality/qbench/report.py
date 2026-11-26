"""Aggregates M0 outputs into results.json and results-tables.md (numbers only, synthetic data)."""

# ruff: noqa: PLR2004, E501, T201
from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

NOISES = ["white", "pink", "brown", "hum", "am_pink", "clicks", "music"]
LANGS = ["english", "hindi", "hinglish"]
SNRS = [20, 10, 5, 0]


def _stats(errors: list[float]) -> dict[str, Any]:
    if not errors:
        return {"n": 0, "mae": None, "bias": None}
    return {
        "n": len(errors),
        "mae": round(sum(abs(e) for e in errors) / len(errors), 2),
        "bias": round(sum(errors) / len(errors), 2),
    }


def _snr_errors(rows: list[dict[str, Any]], key: str) -> list[float]:
    out = []
    for r in rows:
        v = r["vadSnr"]["value"] if key == "vad" else r["wadaSnr"]
        if v is not None:
            out.append(v - r["achievedSnrDb"])
    return out


def snr_tables(rows: list[dict[str, Any]]) -> dict[str, Any]:
    test = [r for r in rows if r["split"] == "test" and r["snr"] != "clean"]
    res: dict[str, Any] = {"n": len(test)}
    for key in ("vad", "wada"):
        unavailable: dict[str, int] = {}
        if key == "vad":
            for r in test:
                if r["vadSnr"]["value"] is None:
                    reason = r["vadSnr"]["reason"]
                    unavailable[reason] = unavailable.get(reason, 0) + 1
        res[key] = {
            "overall": _stats(_snr_errors(test, key)),
            "byNoise": {
                n: _stats(_snr_errors([r for r in test if r["noise"] == n], key)) for n in NOISES
            },
            "byLanguage": {
                g: _stats(_snr_errors([r for r in test if r["language"] == g], key)) for g in LANGS
            },
            "bySnr": {
                str(s): _stats(_snr_errors([r for r in test if r["snr"] == s], key)) for s in SNRS
            },
            "noiseBySnr": {
                n: {
                    str(s): _stats(
                        _snr_errors([r for r in test if r["noise"] == n and r["snr"] == s], key)
                    )
                    for s in SNRS
                }
                for n in NOISES
            },
            "unavailable": unavailable,
        }
    clean = [r for r in rows if r["split"] == "test" and r["snr"] == "clean"]
    res["clean"] = {
        "n": len(clean),
        "vadMedian": _median([r["vadSnr"]["value"] for r in clean]),
        "wadaMedian": _median([r["wadaSnr"] for r in clean]),
        "achievedMedian": _median([r["achievedSnrDb"] for r in clean]),
    }
    return res


def _median(values: list[float | None]) -> float | None:
    v = [x for x in values if x is not None]
    return round(statistics.median(v), 2) if v else None


def speech_tables(rows: list[dict[str, Any]]) -> dict[str, Any]:
    test = [r for r in rows if r["split"] == "test"]

    def agg(sel: list[dict[str, Any]]) -> dict[str, Any]:
        if not sel:
            return {"n": 0}
        err = [r["speechRatioEst"] - r["speechRatioRef"] for r in sel]
        return {
            "n": len(sel),
            "maePct": round(100 * sum(abs(e) for e in err) / len(err), 2),
            "biasPct": round(100 * sum(err) / len(err), 2),
            "precision": round(sum(r["framePrecision"] for r in sel) / len(sel), 3),
            "recall": round(sum(r["frameRecall"] for r in sel) / len(sel), 3),
        }

    return {
        "overall": agg(test),
        "byNoise": {n: agg([r for r in test if r["noise"] == n]) for n in ["none", *NOISES]},
        "byLanguage": {g: agg([r for r in test if r["language"] == g]) for g in LANGS},
        "bySnr": {str(s): agg([r for r in test if r["snr"] == s]) for s in ["clean", *SNRS]},
    }


def block_tables(blocks: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    out = {}
    for size, items in blocks.items():
        errs, eligible, estimable = [], 0, 0
        for it in items:
            for e, r in zip(it["est"], it["ref"], strict=False):
                if r is None:
                    continue
                eligible += 1
                if e is not None:
                    estimable += 1
                    errs.append(e - r)
        out[size] = {
            **_stats(errs),
            "coverage": round(estimable / eligible, 3) if eligible else None,
            "mixtures": len(items),
            "seriesEntriesFor4h": 4 * 3600 * 1000 // int(size),
        }
    return out


def bandwidth_tables(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for cond in ("clean", "white20"):
        for cut in (8000, 7000, 5500, 4000, 3400):
            sel = [r for r in rows if r["condition"] == cond and r["cutoffHz"] == cut]
            out[f"{cond}/{cut}"] = {
                k: {
                    "median": _median([r[k] for r in sel]),
                    "maeHz": round(
                        sum(abs(r[k] - cut) for r in sel if r[k] is not None) / max(1, len(sel)), 1
                    ),
                }
                for k in ("ltasEdgeHz", "rolloff99Hz", "rolloff95Hz")
            } | {"n": len(sel)}
    return out


def checks_table(checks: list[dict[str, Any]]) -> dict[str, Any]:
    status: dict[str, int] = {}
    for c in checks:
        status[c["status"]] = status.get(c["status"], 0) + 1
    dev = [
        c["achievedSnrDb"] - c["targetSnr"]
        for c in checks
        if c["status"] == "verified" and c["targetSnr"] != "clean"
    ]
    return {
        "mixtures": len(checks),
        "status": status,
        "hashOk": sum(1 for c in checks if c.get("hashOk")),
        "regenExact": sum(1 for c in checks if c.get("regenExact")),
        "refExact": sum(1 for c in checks if c.get("refExact")),
        "achievedMinusTargetDb": {
            "n": len(dev),
            "maxAbs": round(max((abs(d) for d in dev), default=0.0), 4),
            "mean": round(sum(dev) / len(dev), 4) if dev else None,
        },
    }


def _fmt(s: dict[str, Any]) -> str:
    return "—" if not s.get("n") else f"{s['mae']:.2f} / {s['bias']:+.2f} ({s['n']})"


def markdown(res: dict[str, Any]) -> str:
    snr = res["snr"]
    lines = ["# Phase 3A M0 results tables (generated; synthetic corpus only)", ""]
    lines += ["## SNR against the known mixing SNR (test split; MAE / mean bias dB (n))", ""]
    lines += [
        "| Group | VAD-split (primary) | WADA-SNR (secondary baseline) |",
        "| --- | --- | --- |",
    ]
    lines.append(f"| all | {_fmt(snr['vad']['overall'])} | {_fmt(snr['wada']['overall'])} |")
    for grp, keys in (
        ("byNoise", NOISES),
        ("byLanguage", LANGS),
        ("bySnr", [str(s) for s in SNRS]),
    ):
        for k in keys:
            lines.append(f"| {k} | {_fmt(snr['vad'][grp][k])} | {_fmt(snr['wada'][grp][k])} |")
    lines += ["", "### Noise type × SNR level, VAD-split (MAE / bias (n))", ""]
    lines += [
        "| Noise | " + " | ".join(f"{s} dB" for s in SNRS) + " |",
        "| --- |" + " --- |" * len(SNRS),
    ]
    for n in NOISES:
        lines.append(
            f"| {n} | " + " | ".join(_fmt(snr["vad"]["noiseBySnr"][n][str(s)]) for s in SNRS) + " |"
        )
    lines += ["", "### Noise type × SNR level, WADA-SNR (MAE / bias (n))", ""]
    lines += [
        "| Noise | " + " | ".join(f"{s} dB" for s in SNRS) + " |",
        "| --- |" + " --- |" * len(SNRS),
    ]
    for n in NOISES:
        lines.append(
            f"| {n} | "
            + " | ".join(_fmt(snr["wada"]["noiseBySnr"][n][str(s)]) for s in SNRS)
            + " |"
        )
    lines += ["", f"VAD-split unavailable (by reason): {snr['vad']['unavailable'] or 'none'}", ""]
    c = snr["clean"]
    lines += [
        f"Clean mixtures (excluded from MAE; n={c['n']}): median VAD-split {c['vadMedian']} dB, "
        f"median WADA {c['wadaMedian']} dB, median computed reference {c['achievedMedian']} dB.",
        "",
    ]
    sp = res["speech"]
    lines += [
        "## Speech ratio (Silero, ADR-0038 settings) against reference labels (test split)",
        "",
    ]
    lines += [
        "| Group | MAE pp | Bias pp | Frame precision | Frame recall | n |",
        "| --- | --- | --- | --- | --- | --- |",
    ]

    def srow(name: str, s: dict[str, Any]) -> str:
        return (
            f"| {name} | {s['maePct']} | {s['biasPct']:+} | {s['precision']} | {s['recall']} | {s['n']} |"
            if s.get("n")
            else f"| {name} | — | — | — | — | 0 |"
        )

    lines.append(srow("all", sp["overall"]))
    for grp in ("byNoise", "byLanguage", "bySnr"):
        for k, s in sp[grp].items():
            lines.append(srow(k, s))
    lines += ["", "## Block size (per-block SNR against per-block reference)", ""]
    lines += [
        "| Block | MAE dB | Bias dB | n blocks | Coverage | Series entries for 4 h |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for size, b in res["blocks"].items():
        lines.append(
            f"| {size} ms | {b['mae']} | {b['bias']} | {b['n']} | {b['coverage']} | {b['seriesEntriesFor4h']} |"
        )
    lines += ["", "## Bandwidth (applied brick-wall cutoff; medians, MAE Hz; n = 12 each)", ""]
    lines += [
        "| Condition / cutoff | LTAS edge | 99 % roll-off | 95 % roll-off |",
        "| --- | --- | --- | --- |",
    ]
    for k, v in res["bandwidth"].items():
        lines.append(
            f"| {k} | {v['ltasEdgeHz']['median']} ({v['ltasEdgeHz']['maeHz']}) | "
            f"{v['rolloff99Hz']['median']} ({v['rolloff99Hz']['maeHz']}) | "
            f"{v['rolloff95Hz']['median']} ({v['rolloff95Hz']['maeHz']}) |"
        )
    return "\n".join(lines) + "\n"


def main(out_dir: Path, docs_dir: Path) -> None:
    load = lambda name: json.loads((out_dir / name).read_text())  # noqa: E731
    rows = load("estimates.json")
    res = {
        "checks": checks_table(load("checks.json")),
        "snr": snr_tables(rows),
        "speech": speech_tables(rows),
        "blocks": block_tables(load("blocks.json")),
        "bandwidth": bandwidth_tables(load("bandwidth.json")),
        "fragmentation": load("fragmentation.json"),
        "determinism": load("determinism.json"),
        "cost": load("cost.json") if (out_dir / "cost.json").exists() else None,
    }
    docs_dir.mkdir(parents=True, exist_ok=True)
    (docs_dir / "results.json").write_text(json.dumps(res, indent=1, sort_keys=True) + "\n")
    (docs_dir / "results-tables.md").write_text(markdown(res))
    print(f"wrote {docs_dir}/results.json and results-tables.md")
