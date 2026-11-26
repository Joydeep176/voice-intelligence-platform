"""Phase 3A M0 feasibility harness (benchmark only; not part of the service or its image).

Indicative only: it runs the candidate algorithms with the image's pinned libraries, NOT the
production `measure` task (no task API, sandbox, deadline or concurrent service). M4 repeats cost,
memory and sandbox validation on the implemented task.

Container steps (production image, --cpus 2 --memory 768m, models at /models, corpus at /corpus):
  python run.py estimate | bandwidth | fragmentation | determinism | cost
Host step:
  uv run --directory services/audio python benchmarks/quality/run.py report <out-dir>
"""

# ruff: noqa: T201, PLR2004
from __future__ import annotations

import hashlib
import json
import os
import resource
import sys
import threading
import time
import wave
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "vad"))

import numpy as np  # noqa: E402
from qbench import estimators as est  # noqa: E402

CORPUS = Path(os.environ.get("QB_CORPUS", "/corpus"))
OUT = Path(os.environ.get("QB_OUT", "/out"))
BLOCK_SIZES_MS = (500, 1000)
BLOCK_NOISES = ("white", "pink", "am_pink", "music")
BLOCK_SNRS = (20, 10, 5)
CUTOFFS_HZ = (None, 7000, 5500, 4000, 3400)


def manifest() -> dict[str, Any]:
    return json.loads((CORPUS / "index.json").read_text())


def write(name: str, obj: Any) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(obj, indent=1, sort_keys=True) + "\n")
    print(f"wrote {name}", flush=True)


def analyse(x: np.ndarray) -> dict[str, Any]:
    """Speech split + SNR estimates for one signal (float64 full scale)."""
    from qbench import vad  # noqa: PLC0415 (container only)

    power = est.frame_power(x)
    n_frames, length_ms = len(power), len(x) // 16
    raw = vad.raw_spans(x)
    speech = est.spans_to_mask(raw, n_frames)
    noise = ~est.spans_to_mask(vad.padded(raw, length_ms), n_frames)
    return {
        "raw": raw,
        "power": power,
        "speech": speech,
        "noise": noise,
        "vadSnr": est.vad_split_snr(power, speech, noise),
        "vadSnrP20": est.vad_split_snr_robust(power, speech, noise, 20.0),
        "vadSnrP50": est.vad_split_snr_robust(power, speech, noise, 50.0),
        "wadaSnr": est.wada_snr(x),
    }


# -- estimate: SNR, speech ratio, block size (all mixtures) ---------------------------------------


def cmd_estimate() -> None:
    from qbench.reference import regenerate  # noqa: PLC0415

    rows, blocks, checks = [], {str(b): [] for b in BLOCK_SIZES_MS}, []
    t0 = time.time()
    for i, m in enumerate(manifest()["mixtures"]):
        comp, check = regenerate(m, CORPUS)
        checks.append(check)
        if comp is None:
            continue
        a = analyse(comp.mixture)
        ref = comp.ref[: len(a["speech"])]
        sp = a["speech"][: len(ref)]
        tp = int((sp & ref).sum())
        rows.append(
            {
                "id": m["id"],
                "split": m["split"],
                "language": m["language"],
                "noise": m["noise"],
                "snr": m["snr"],
                "achievedSnrDb": check["achievedSnrDb"],
                "vadSnr": a["vadSnr"],
                "wadaSnr": a["wadaSnr"],
                "vadSnrP20": a["vadSnrP20"],
                "vadSnrP50": a["vadSnrP50"],
                "speechRatioEst": float(a["speech"].mean()),
                "speechRatioRef": float(comp.ref.mean()),
                "framePrecision": tp / max(1, int(sp.sum())),
                "frameRecall": tp / max(1, int(ref.sum())),
                "spanCount": len(a["raw"]),
            }
        )
        if m["split"] == "test" and m["noise"] in BLOCK_NOISES and m["snr"] in BLOCK_SNRS:
            cp, npow = est.frame_power(comp.clean), est.frame_power(comp.noise)
            n = min(len(cp), len(a["power"]), len(comp.ref))
            for b in BLOCK_SIZES_MS:
                bf = b // 10
                e = est.block_snr(a["power"][:n], a["speech"][:n], a["noise"][:n], bf)
                r = est.block_reference_snr(cp[:n], npow[:n], comp.ref[:n], bf)
                blocks[str(b)].append(
                    {"id": m["id"], "noise": m["noise"], "snr": m["snr"], "est": e, "ref": r}
                )
        if i % 25 == 0:
            print(f"{i} mixtures, {time.time() - t0:.0f}s", flush=True)
    write("checks.json", checks)
    write("estimates.json", rows)
    write("blocks.json", blocks)


# -- bandwidth -------------------------------------------------------------------------------------


def cmd_bandwidth() -> None:
    from qbench import vad  # noqa: PLC0415
    from qbench.reference import read_wav_float  # noqa: PLC0415

    sel = [
        m
        for m in manifest()["mixtures"]
        if m["split"] == "test"
        and (m["snr"] == "clean" or (m["noise"] == "white" and m["snr"] == 20))
    ]
    rows = []
    for m in sel:
        x = read_wav_float(CORPUS / m["wav"])
        speech = est.spans_to_mask(vad.raw_spans(x), len(x) // est.FRAME)
        for cut in CUTOFFS_HZ:
            y = x if cut is None else est.quantise(est.lowpass(x, cut))
            spectra = est.speech_spectra(y, speech)
            rows.append(
                {
                    "id": m["id"],
                    "condition": "clean" if m["snr"] == "clean" else "white20",
                    "cutoffHz": cut or 8000,
                    "rolloff99Hz": est.rolloff_hz(spectra),
                    "rolloff95Hz": est.rolloff_hz(spectra, 0.95),
                    "ltasEdgeHz": est.ltas_edge_hz(spectra),
                }
            )
    write("bandwidth.json", rows)


# -- fragmentation ---------------------------------------------------------------------------------

SOURCE = Path(os.environ.get("QB_E2E_IDS", "/e2e"))


def reconstruct(ids: list[str], *, max_s: float | None, gap_s: float, lead_s: float) -> np.ndarray:
    from qbench.reference import read_wav_float  # noqa: PLC0415

    parts = [np.zeros(int(lead_s * 16_000))]
    for uid in ids:
        u = read_wav_float(CORPUS / "utterances" / f"{uid}.wav")
        parts += [u if max_s is None else u[: int(max_s * 16_000)], np.zeros(int(gap_s * 16_000))]
    return np.concatenate(parts)


def cmd_fragmentation() -> None:
    from qbench import vad  # noqa: PLC0415

    dense = json.loads((SOURCE / "dense-ids.json").read_text())
    frag = json.loads((SOURCE / "fragmented-ids.json").read_text())
    out = {}
    for name, x, recorded in (
        ("dense_13utt_0.45s", reconstruct(dense, max_s=None, gap_s=0.45, lead_s=0.5), 2),
        ("fragmented_16x1s_0.8s", reconstruct(frag, max_s=1.0, gap_s=0.8, lead_s=0.5), 14),
    ):
        per_window = vad.window_spans(x)
        out[name] = {
            **est.spans_per_window(per_window),
            "durationS": len(x) / 16_000,
            "recordedIn2cTranscription": recorded,
            "reconstruction": True,
        }
    write("fragmentation.json", out)


# -- determinism -----------------------------------------------------------------------------------


def digest(a: dict[str, Any]) -> str:
    keep = {
        "raw": a["raw"],
        "vadSnr": a["vadSnr"],
        "wadaSnr": a["wadaSnr"],
        "speech": hashlib.sha256(a["speech"].tobytes()).hexdigest(),
    }
    return hashlib.sha256(json.dumps(keep, sort_keys=True).encode()).hexdigest()


def cmd_determinism() -> None:
    from qbench.reference import read_wav_float  # noqa: PLC0415

    sel = [
        m
        for m in manifest()["mixtures"]
        if m["split"] == "test" and m["scene"] == 0 and m["snr"] in ("clean", 10)
    ][:12]
    out = []
    for m in sel:
        x = read_wav_float(CORPUS / m["wav"])
        d1, d2 = digest(analyse(x)), digest(analyse(x))
        out.append({"id": m["id"], "identical": d1 == d2, "digest": d1})
    write(
        "determinism.json",
        {"runs": out, "allIdentical": all(r["identical"] for r in out), "vadThreads": 1},
    )


# -- cost (streaming, long files) ------------------------------------------------------------------


class MemSampler(threading.Thread):
    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.samples: list[tuple[float, int]] = []
        self.stop = False

    def run(self) -> None:
        while not self.stop:
            try:
                for line in Path("/sys/fs/cgroup/memory.stat").read_text().splitlines():
                    if line.startswith("anon "):
                        self.samples.append((time.monotonic(), int(line.split()[1])))
                        break
            except OSError:
                return
            time.sleep(0.05)


def stream_analyse(path: Path) -> dict[str, Any]:
    from qbench.vad import StreamingVad  # noqa: PLC0415

    block = 30 * 16_000
    powers, svad = [], StreamingVad()
    with wave.open(str(path)) as w:
        n_total = w.getnframes()
        while chunk := w.readframes(block):
            x = np.frombuffer(chunk, dtype="<i2").astype(np.float64) / 32768.0
            powers.append(est.frame_power(x))
            svad.feed(x)
    spans = svad.finish()
    power = np.concatenate(powers)
    speech = est.spans_to_mask(spans, len(power))
    from qbench.vad import padded  # noqa: PLC0415

    noise = ~est.spans_to_mask(padded(spans, n_total // 16), len(power))
    # second pass: long-term spectrum over speech frames and 1 s block SNR series
    win, ltas, frames = np.hanning(est.FFT_SIZE), np.zeros(est.FFT_SIZE // 2 + 1), 0
    with wave.open(str(path)) as w:
        offset = 0
        while chunk := w.readframes(block):
            x = np.frombuffer(chunk, dtype="<i2").astype(np.float64) / 32768.0
            for s in range(0, len(x) - est.FFT_SIZE + 1, est.FFT_SIZE):
                f0 = (offset + s) // est.FRAME
                f1 = (offset + s + est.FFT_SIZE - 1) // est.FRAME
                if f1 < len(speech) and speech[f0 : f1 + 1].all():
                    ltas += np.abs(np.fft.rfft(x[s : s + est.FFT_SIZE] * win)) ** 2
                    frames += 1
            offset += len(x)
    series = est.block_snr(power, speech, noise, 100)
    return {
        "durationS": n_total / 16_000,
        "spans": len(spans),
        "vadSnr": est.vad_split_snr(power, speech, noise)["value"],
        "speechRatio": float(speech.mean()),
        "spectrumFrames": frames,
        "seriesBlocks": len(series),
    }


def cmd_cost() -> None:
    out = {}
    for name in ("long-60", "long-120"):
        sampler = MemSampler()
        sampler.start()
        t0, c0 = time.monotonic(), time.process_time()
        result = stream_analyse(CORPUS / "long" / f"{name}.wav")
        wall, cpu = time.monotonic() - t0, time.process_time() - c0
        sampler.stop = True
        sampler.join()
        s = sampler.samples
        third = (s[-1][0] - s[0][0]) / 3 if len(s) > 1 else 0
        first = max((v for t, v in s if t <= s[0][0] + third), default=0)
        last = max((v for t, v in s if t >= s[-1][0] - third), default=0)
        out[name] = {
            **result,
            "wallS": wall,
            "cpuS": cpu,
            "rtf": wall / result["durationS"],
            "anonPeakMiB": max((v for _, v in s), default=0) / 2**20,
            "anonFirstThirdMiB": first / 2**20,
            "anonLastThirdMiB": last / 2**20,
            "maxRssMiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
        }
    try:
        out["cgroupMemoryPeakMiB"] = int(Path("/sys/fs/cgroup/memory.peak").read_text()) / 2**20
    except OSError:
        out["cgroupMemoryPeakMiB"] = None
    out["cpusLimit"] = Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    out["memoryLimitBytes"] = Path("/sys/fs/cgroup/memory.max").read_text().strip()
    write("cost.json", out)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "report":
        from qbench.report import main as report_main  # noqa: PLC0415

        report_main(Path(sys.argv[2]), Path(sys.argv[3]))
    else:
        {
            "estimate": cmd_estimate,
            "bandwidth": cmd_bandwidth,
            "fragmentation": cmd_fragmentation,
            "determinism": cmd_determinism,
            "cost": cmd_cost,
        }[cmd]()
