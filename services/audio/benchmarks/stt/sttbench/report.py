"""Build results.json and results-tables.md from the container outputs (host side, pure Python)."""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from .common import read_json, write_json
from .engines import ENGINE_IDS
from .textnorm import char_errors, word_errors

LANGS = ["english", "hindi", "hinglish"]
SNR_KEYS = ["clean", "20", "10", "5"]
DIAR = ["campplus", "wespeaker"]
MIB = 1024 * 1024
ORACLE_MAX_S = 400  # same bound as diarbench.evaluate


def _opt(path: Path) -> Any:
    return read_json(path) if path.exists() else None


def _score_rows(rows: list[dict[str, Any]], clips: dict[str, dict[str, Any]]) -> dict[str, Any]:
    cell: dict[tuple[str, str], dict[str, float]] = defaultdict(lambda: defaultdict(float))
    lid: dict[str, Counter[str]] = defaultdict(Counter)
    for r in rows:
        c = clips[r["file"]]
        if c["split"] != "test":
            continue
        we, wn = word_errors(c["text"], r["hyp"])
        ce, cn = char_errors(c["text"], r["hyp"])
        keys = [(c["language"], str(c["snr"]))]
        if c["language"] == "hinglish":
            keys.append((f"hinglish-{c['group']}", str(c["snr"])))
        for k in keys:
            cell[k]["we"] += we
            cell[k]["wn"] += wn
            cell[k]["ce"] += ce
            cell[k]["cn"] += cn
            cell[k]["clips"] += 1
        lid[f"{c['language']}|{c['snr']}"][r["lang"] or "none"] += 1
    table: dict[str, dict[str, Any]] = {}
    for (lang, snr), v in cell.items():
        table.setdefault(lang, {})[snr] = {
            "wer": v["we"] / v["wn"] if v["wn"] else None,
            "cer": v["ce"] / v["cn"] if v["cn"] else None,
            "clips": int(v["clips"]),
            "ref_words": int(v["wn"]),
            "ref_chars": int(v["cn"]),
        }
    lang_id: dict[str, Any] = {}
    for lang, expect in (("english", "en"), ("hindi", "hi")):
        n = hit = 0
        for key, counts in lid.items():
            if key.startswith(lang + "|"):
                n += sum(counts.values())
                hit += counts.get(expect, 0)
        reported = any(
            k != "none" for key, c in lid.items() if key.startswith(lang + "|") for k in c
        )
        lang_id[lang] = {
            "accuracy": hit / n if n and reported else None,
            "clips": n,
            "expected": expect,
        }
    hing: Counter[str] = Counter()
    for key, counts in lid.items():
        if key.startswith("hinglish|"):
            hing.update(counts)
    lang_id["hinglish_detected"] = dict(hing)
    return {"table": table, "language_id": lang_id}


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + " --- |" * len(headers)]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return [*out, ""]


def _long(lg: dict[str, Any]) -> str:
    return (
        f"{lg.get('audio_s', 0) / 60:.0f} min: {lg.get('wall_s', 0):.0f} s / {lg.get('rtf', 0):.3f}"
    )


def _feasibility(f: dict[str, Any] | None, r5: dict[str, Any] | None) -> str:
    if not f:
        return "not run"
    if f.get("oom_killed"):
        text = "OOM-killed"
    elif f.get("exit_code") == 0:
        text = "completed"
    else:
        text = f"exit {f.get('exit_code')}"
    if r5 and r5.get("completed"):
        text += f" (peak {r5['memory_peak_mib']:.0f} MiB)"
    return text


def _diar_determinism(a: dict[str, Any], b: dict[str, Any] | None) -> dict[str, int] | None:
    if not b:
        return None
    ra = {r["id"]: (r["tuned"], r.get("oracle_k")) for r in a["rows"]}
    same = sum(ra[r["id"]] == (r["tuned"], r.get("oracle_k")) for r in b["rows"])
    return {"conversations_compared": len(b["rows"]), "identical": same}


def _pct(v: float | None) -> str:
    return "n/a (no language reported)" if v is None else f"{v * 100:.1f}%"


def _deva_share(text: str) -> float:
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return 0.0
    return sum("\u0900" <= ch <= "\u097f" for ch in letters) / len(letters)


def _script_share(
    rows: list[dict[str, Any]], clips: dict[str, dict[str, Any]], common: set[str]
) -> dict[str, dict[str, float]]:
    """Share of Devanagari among letters, hypotheses against references (common clips, clean)."""
    out: dict[str, dict[str, list[float]]] = {}
    for r in rows:
        c = clips[r["file"]]
        if r["file"] not in common or str(c["snr"]) != "clean":
            continue
        g = out.setdefault(c["group"], {"ref": [], "hyp": []})
        g["ref"].append(_deva_share(c["text"]))
        g["hyp"].append(_deva_share(r["hyp"]))
    return {grp: {k: sum(v) / len(v) for k, v in d.items()} for grp, d in out.items() if d["ref"]}


def _fmt(v: float | None, pct: bool = True) -> str:
    return "n/a" if v is None else (f"{v * 100:.1f}" if pct else f"{v:.3f}")


def build(root: Path, docs: Path) -> None:  # noqa: PLR0912, PLR0915
    sidx = read_json(root / "stt-corpus" / "index.json")
    clips = {c["file"]: c for c in sidx["clips"]}
    res_dir, dres_dir = root / "stt-results", root / "diar-results"
    out: dict[str, Any] = {"stt": {}, "diarization": {}}
    md: list[str] = []
    accs = {e: _opt(res_dir / f"accuracy-{e}-a.json") for e in ENGINE_IDS}
    accs = {e: a for e, a in accs.items() if a}
    common = set.intersection(
        *(
            {r["file"] for r in a["rows"] if clips[r["file"]]["split"] == "test"}
            for a in accs.values()
        )
    )
    for e, a in accs.items():
        b = _opt(res_dir / f"accuracy-{e}-b.json")
        scored = _score_rows(a["rows"], clips)
        scored["common"] = _score_rows([r for r in a["rows"] if r["file"] in common], clips)[
            "table"
        ]
        det = None
        if b:
            ra = {r["file"]: (r["hyp"], r["lang"]) for r in a["rows"]}
            # Only clips scored in both passes (a partial pass a may not cover pass b's clips).
            both = [r for r in b["rows"] if r["file"] in ra]
            same = sum(ra[r["file"]] == (r["hyp"], r["lang"]) for r in both)
            det = {"clips_compared": len(both), "identical": same}
        out["stt"][e] = {
            "engine": a["engine"],
            "model_files": a["model_files"],
            "accuracy_threads": a["threads"],
            **scored,
            "script_share": _script_share(a["rows"], clips, common),
            "full_run_clips": a["clips"],
            "determinism": det,
            "resources_main": _opt(res_dir / f"resources-{e}-main.json"),
            "resources_512m": _opt(res_dir / f"resources-{e}-512m.json"),
            "feasibility_512m": _opt(res_dir / f"feasibility-{e}.json"),
        }
    for cnd in DIAR:
        ev = _opt(dres_dir / f"diar-eval-{cnd}-a.json")
        if not ev:
            continue
        evb = _opt(dres_dir / f"diar-eval-{cnd}-b.json")
        out["diarization"][cnd] = {
            "eval": ev,
            "determinism": _diar_determinism(ev, evb),
            "tuning": _opt(dres_dir / f"diar-tuning-{cnd}.json"),
            "resources_main": _opt(dres_dir / f"diar-resources-{cnd}-main.json"),
            "resources_512m": _opt(dres_dir / f"diar-resources-{cnd}-512m.json"),
            "feasibility_512m": _opt(dres_dir / f"feasibility-{cnd}.json"),
        }
    write_json(docs / "results.json", out)

    md.append(
        f"## Common subset: the {len(common)} test clips every engine transcribed (percent)\n"
    )
    md.append(
        "Same clips for every engine (clean and 10 dB, first 10 sentences per language, Hinglish "
        "5 per kind), so the rows are directly comparable. Cells hold few words: read "
        "differences of a few points as noise.\n"
    )
    for metric, label in (("wer", "WER"), ("cer", "CER")):
        rows = []
        for d in out["stt"].values():
            for lang in [*LANGS, "hinglish-hd", "hinglish-hr"]:
                t = d["common"].get(lang)
                if t:
                    cells = [_fmt(t.get(s, {}).get(metric)) for s in ("clean", "10")]
                    rows.append([d["engine"], lang, *cells, str(t["clean"]["clips"])])
        md.append(f"### {label}\n")
        md += _table(["Engine", "Language", "clean", "10 dB", "clips/cell"], rows)
    md.append(
        "## STT accuracy (test split, percent; WER = word, CER = code point; lower is better)\n"
    )
    for metric, label in (("wer", "WER"), ("cer", "CER")):
        md.append(f"### {label}\n")
        rows = []
        for d in out["stt"].values():
            for lang in [*LANGS, "hinglish-hd", "hinglish-hr"]:
                t = d["table"].get(lang)
                if t:
                    cells = [_fmt(t.get(s, {}).get(metric)) for s in SNR_KEYS]
                    rows.append([d["engine"], lang, *cells, str(t["clean"]["clips"])])
        md += _table(["Engine", "Language", "clean", "20 dB", "10 dB", "5 dB", "clips/cell"], rows)
    md.append("### Language identification (test split, auto-detect, all SNRs pooled)\n")
    rows = []
    for d in out["stt"].values():
        li = d["language_id"]
        codes = dict(sorted(li["hinglish_detected"].items(), key=lambda kv: -kv[1]))
        rows.append(
            [
                d["engine"],
                _pct(li["english"]["accuracy"]),
                _pct(li["hindi"]["accuracy"]),
                str(codes),
            ]
        )
    md += _table(["Engine", "English as en", "Hindi as hi", "Hinglish clips: detected codes"], rows)
    md.append("### Determinism (two runs, same settings, first 40 clips)\n")
    rows = []
    for d in out["stt"].values():
        x = d["determinism"]
        rows.append(
            [d["engine"], "not run" if not x else f"{x['identical']} of {x['clips_compared']}"]
        )
    md += _table(["Engine", "Identical text and language"], rows)

    md.append("## STT resources (1 CPU, container; limits in the README)\n")
    rows = []
    for d in out["stt"].values():
        r = d["resources_main"]
        if not r:
            continue
        lg = r.get("long") or {}
        rows.append(
            [
                d["engine"],
                f"{r['model_disk_bytes'] / MIB:.0f}",
                f"{r['load_s']:.1f}",
                f"{r['short']['rtf_median']:.3f}",
                f"{r['short']['cpu_s_per_audio_hour_median']:.0f}",
                f"{r['anon_after_load_mib']:.0f}",
                f"{r.get('memory_peak_mib', 0):.0f}",
                f"{r.get('anon_max_mib', 0):.0f}",
                _long(lg),
                f"{lg.get('anon_first_third_max_mib', 0):.0f} / "
                f"{lg.get('anon_last_third_max_mib', 0):.0f}",
                _feasibility(d["feasibility_512m"], d["resources_512m"]),
            ]
        )
    md += _table(
        ["Engine", "Disk MiB", "Load s", "RTF (median of 3)", "CPU s per audio hour",
         "Anon after load MiB", "memory.peak MiB", "Anon max MiB", "Long file: wall / RTF",
         "Long file anon first / last third MiB", "512 MiB container"],
        rows,
    )  # fmt: skip

    md.append("## Diarization (test split; 250 ms collar; overlaps scored; percent)\n")
    modes = (
        ("tuned", "dev-tuned clustering threshold"),
        ("oracle_k", "oracle speaker count"),
    )
    for mode, label in modes:
        md.append(f"### DER by speaker count, {label}\n")
        rows = []
        for cnd, d in out["diarization"].items():
            for n in (2, 3, 4):
                sel = [
                    r
                    for r in d["eval"]["rows"]
                    if r["split"] == "test"
                    and r["n_speakers"] == n
                    and mode in r
                    and (mode == "tuned" or r["seconds"] < ORACLE_MAX_S)
                ]
                if not sel:
                    continue
                tot = sum(r[mode]["ref_speech_s"] for r in sel)
                avg = {
                    k: sum(r[mode][k] * r[mode]["ref_speech_s"] for r in sel) / tot * 100
                    for k in ("der", "missed", "false_alarm", "confusion")
                }
                exact = sum(r[mode]["hyp_speakers"] == n for r in sel)
                mean_k = sum(r[mode]["hyp_speakers"] for r in sel) / len(sel)
                rows.append(
                    [cnd, str(n), str(len(sel)), *(f"{avg[k]:.1f}" for k in avg),
                     f"{exact}/{len(sel)}", f"{mean_k:.1f}"]
                )  # fmt: skip
        md += _table(
            ["Candidate", "Speakers", "Conversations", "DER", "Missed", "False alarm", "Confusion",
             "Speaker count exact", "Mean detected"],
            rows,
        )  # fmt: skip
    md.append("### Diarization resources (1 CPU)\n")
    rows = []
    for cnd, d in out["diarization"].items():
        r = d["resources_main"]
        if not r:
            continue
        lg = r.get("long") or {}
        rows.append(
            [
                cnd,
                f"{r['model_disk_bytes'] / MIB:.0f}",
                f"{r['load_s']:.1f}",
                f"{r['short']['rtf_median']:.3f}",
                f"{r['short']['cpu_s_per_audio_hour_median']:.0f}",
                _long(lg),
                f"{lg.get('der', 0) * 100:.1f}",
                f"{lg.get('anon_max_mib', 0):.0f}",
                f"{r.get('memory_peak_mib', 0):.0f}",
                _feasibility(d["feasibility_512m"], d["resources_512m"]),
            ]
        )
    md += _table(
        ["Candidate", "Disk MiB", "Load s", "RTF (median of 3, 5 min file)", "CPU s per audio hour",
         "Long file: wall / RTF", "Long file DER", "Long file anon max MiB", "memory.peak MiB",
         "512 MiB container"],
        rows,
    )  # fmt: skip
    md.append(
        "### Script of Hinglish output (clean, common clips): share of Devanagari among letters\n"
    )
    rows = []
    for d in out["stt"].values():
        ss = d["script_share"]
        rows.append(
            [
                d["engine"],
                *(
                    f"{ss[g]['hyp'] * 100:.0f}% (reference {ss[g]['ref'] * 100:.0f}%)"
                    for g in ("hd", "hr")
                    if g in ss
                ),
            ]
        )
    md += _table(["Engine", "Devanagari-mixed Hinglish (hd)", "Romanised Hinglish (hr)"], rows)
    md.append(
        "### Code-switch examples (synthetic text, clean, first clips of each Hinglish kind)\n"
    )
    for e, a in accs.items():
        picked: dict[str, int] = {}
        for r in a["rows"]:
            c = clips[r["file"]]
            ok = c["group"] in {"hd", "hr"} and str(c["snr"]) == "clean" and r["file"] in common
            if ok and picked.get(c["group"], 0) < 2:  # noqa: PLR2004
                picked[c["group"]] = picked.get(c["group"], 0) + 1
                md.append(f"- `{e}` {c['group']} ref: {c['text']}  \n  hyp: {r['hyp'].strip()}")
        md.append("")
    (docs / "results-tables.md").write_text("\n".join(md) + "\n", encoding="utf-8")
