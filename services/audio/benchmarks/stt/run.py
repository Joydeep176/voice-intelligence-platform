"""Single entry point of the Phase 2C STT and diarization benchmark. Selects nothing (OD-02b).

Host, from the repository root (needs macOS `say`, curl and Docker; the container stages are
offline, hardened and run with the limits recorded in the report):

    uv run --directory services/audio --no-dev --group stt-benchmark \
        python benchmarks/stt/run.py all

`all` = fetch (verify pinned model hashes) -> corpora (host TTS) -> docker build of the
`phase2c-benchmark` stage -> per STT engine: accuracy (twice, for determinism), resources at
1 CPU, 512 MB feasibility -> per diarization candidate: tune (dev), evaluate (twice), resources,
512 MB feasibility -> report. Stages can be run on their own (see --help). Container stages are
the same file with the `c-*` stages. Nothing is downloaded except what DEPENDENCIES.md records.
"""

from __future__ import annotations

import argparse
import subprocess  # noqa: S404
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent / "diarization"))

from sttbench.common import read_json, write_json  # noqa: E402
from sttbench.engines import ENGINE_IDS  # noqa: E402

DIAR_CANDIDATES = ["campplus", "wespeaker"]
IMAGE = "vip-phase2c-benchmark"
_PARTS = Path(__file__).resolve().parents
REPO = _PARTS[4] if len(_PARTS) > 4 else Path("/")  # noqa: PLR2004  (image: container stages only)
ROOT = REPO / ".local-benchmarks"
DOCS = REPO / "docs" / "development" / "phase2c-stt-benchmark"
MAIN_MEMORY = "3g"  # what the larger models need; the production audio container is 512 MB / 1 CPU
ACCURACY_THREADS = 4


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def docker(
    stage_args: list[str], *, cpus: str, memory: str, threads: int, name: str | None = None
) -> int:
    cmd = ["docker", "run", "--init", "--read-only", "--cap-drop", "ALL"]
    cmd += ["--security-opt", "no-new-privileges", "--pids-limit", "128", "--network", "none"]
    cmd += ["--memory", memory, "--memory-swap", memory, "--cpus", cpus]
    cmd += ["--tmpfs", "/tmp:size=64m,noexec,nosuid,nodev"]  # noqa: S108
    cmd += ["-e", f"BENCH_THREADS={threads}", "-e", "HOME=/tmp", "-e", "HF_HUB_OFFLINE=1"]
    cmd += ["-e", "OMP_NUM_THREADS=" + str(threads)]
    cmd += ["-v", f"{ROOT / 'stt-corpus'}:/data/stt-corpus:ro"]
    cmd += ["-v", f"{ROOT / 'diar-corpus'}:/data/diar-corpus:ro"]
    cmd += ["-v", f"{ROOT / 'vad-corpus' / 'long'}:/data/long:ro"]
    cmd += ["-v", f"{ROOT / 'stt-models'}:/data/models:ro"]
    cmd += ["-v", f"{ROOT / 'stt-results'}:/data/stt-results"]
    cmd += ["-v", f"{ROOT / 'diar-results'}:/data/diar-results"]
    cmd += ["--name", name] if name else ["--rm"]
    cmd += [IMAGE, "python", "benchmarks/stt/run.py", *stage_args]
    return subprocess.run(cmd, check=False).returncode  # noqa: S603


def _oom_killed(name: str) -> bool:
    out = subprocess.run(  # noqa: S603
        ["docker", "inspect", "-f", "{{.State.OOMKilled}}", name],  # noqa: S607
        capture_output=True,
        text=True,
        check=False,
    ).stdout.strip()
    subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)  # noqa: S603, S607
    return out == "true"


def host_fetch(args: argparse.Namespace) -> None:
    from sttbench.fetch import fetch  # noqa: PLC0415

    fetch(ROOT / "stt-models", args.only)


def host_corpus(_: argparse.Namespace) -> None:
    from diarbench import corpus as dc  # noqa: PLC0415
    from sttbench import corpus as sc  # noqa: PLC0415

    sm = sc.build(ROOT / "vad-corpus", ROOT / "stt-corpus")
    log(f"stt corpus: {len(sm['clips'])} clips")
    dm = dc.build(ROOT / "vad-corpus", ROOT / "diar-corpus")
    log(f"diarization corpus: {len(dm['conversations'])} conversations")
    DOCS.mkdir(parents=True, exist_ok=True)
    stt_idx = {k: v for k, v in sm.items() if k != "clips"}
    stt_idx["clips"] = [{k: v for k, v in c.items() if k != "text"} for c in sm["clips"]]
    write_json(DOCS / "corpus-manifest-stt.json", stt_idx)
    diar_idx = {k: v for k, v in dm.items() if k != "voice_utterances"}
    diar_idx["voice_utterances"] = dm["voice_utterances"]
    diar_idx["conversations"] = [
        {k: v for k, v in c.items() if k != "segments"} | {"reference_segments": len(c["segments"])}
        for c in dm["conversations"]
    ]
    write_json(DOCS / "corpus-manifest-diarization.json", diar_idx)


def host_build(_: argparse.Namespace) -> None:
    subprocess.run(  # noqa: S603
        [  # noqa: S607
            "docker",
            "build",
            "-f",
            str(REPO / "services/audio/Dockerfile"),
            "--target",
            "phase2c-benchmark",
            "-t",
            IMAGE,
            str(REPO / "services/audio"),
        ],
        check=True,
    )


def _resources_runs(kind: str, ident: str, out_dir: Path, long_minutes: float, prefix: str) -> None:
    """Main run (1 CPU, 3 GiB) and 512 MiB feasibility run of one candidate; no other load."""
    flag = "--engine" if kind == "stt" else "--candidate"
    stage = f"c-{kind}-resources"
    docker(
        [stage, flag, ident, "--tag", "main", "--long-minutes", str(long_minutes)],
        cpus="1",
        memory=MAIN_MEMORY,
        threads=1,
    )
    main = out_dir / f"{prefix}-{ident}-main.json"
    info = read_json(main) if main.exists() else {}
    # If anonymous memory in the 3 GiB run already exceeded 512 MiB the long file would only
    # repeat the OOM kill (and cost the full run time again): the 512 MiB run is then short-only.
    fits = info.get("anon_max_mib", 1e9) < 440  # noqa: PLR2004
    long_done = (info.get("long") or {}).get("audio_s", 0) / 60
    name = f"vip-feas-{kind}-{ident}"
    code = docker(
        [stage, flag, ident, "--tag", "512m", "--long-minutes", str(long_done if fits else 0)],
        cpus="1",
        memory="512m",
        threads=1,
        name=name,
    )
    write_json(
        out_dir / f"feasibility-{ident}.json",
        {
            "id": ident,
            "memory": "512m",
            "exit_code": code,
            "oom_killed": _oom_killed(name),
            "long_minutes_in_512m_run": long_done if fits else 0,
        },
    )


def host_stt(args: argparse.Namespace) -> None:
    snr_args = ["--snrs", args.snrs] if args.snrs else []
    if args.per_language:
        snr_args += ["--per-language", str(args.per_language)]
    for e in [args.engine] if args.engine else ENGINE_IDS:
        if args.phase in {"accuracy", "both"}:
            for tag, extra in (("a", []), ("b", ["--limit", str(args.b_limit)])):
                if tag not in args.tags.split(","):
                    continue
                docker(
                    ["c-stt-accuracy", "--engine", e, "--tag", tag, *extra, *snr_args],
                    cpus=str(ACCURACY_THREADS),
                    memory="3g",
                    threads=ACCURACY_THREADS,
                )
        if args.phase in {"resources", "both"}:
            _resources_runs("stt", e, ROOT / "stt-results", args.long_minutes, "resources")


def host_diar(args: argparse.Namespace) -> None:
    for cand in [args.candidate] if args.candidate else DIAR_CANDIDATES:
        if args.phase in {"accuracy", "both"}:
            if not args.skip_tune:
                docker(["c-diar-tune", "--candidate", cand], cpus="3", memory="1g", threads=3)
            a_extra = ["--limit", str(args.a_limit)] if args.a_limit else []
            for tag, extra in (("a", a_extra), ("b", ["--limit", "1"])):
                if tag not in args.tags.split(","):
                    continue
                docker(
                    ["c-diar-eval", "--candidate", cand, "--tag", tag, *extra],
                    cpus="3",
                    memory="1g",
                    threads=3,
                )
        if args.phase in {"resources", "both"}:
            _resources_runs(
                "diar", cand, ROOT / "diar-results", args.long_minutes, "diar-resources"
            )


BENCHMARK_PACKAGES = {
    "faster-whisper",
    "ctranslate2",
    "av",
    "tokenizers",
    "huggingface-hub",
    "hf-xet",
    # pywhispercpp, sherpa-onnx and sherpa-onnx-core are runtime dependencies since the provider
    # selection (OD-02b / OD-03b, ADR-0036 / ADR-0037), so they are no longer checked as absent.
    "onnxruntime",
    "webrtcvad-wheels",
    "httpx2",
    "httpcore2",
}


def host_check_runtime(_: argparse.Namespace) -> None:
    """The default (`runtime`) image must contain none of the benchmark-only packages."""
    tag = "vip-audio-runtime-check"
    subprocess.run(  # noqa: S603
        [  # noqa: S607
            "docker",
            "build",
            "-q",
            "-f",
            str(REPO / "services/audio/Dockerfile"),  # noqa: S607
            "--target",
            "runtime",
            "-t",
            tag,
            str(REPO / "services/audio"),
        ],
        check=True,
    )
    code = (
        "import importlib.metadata as m;"
        "print('\\n'.join(sorted({d.metadata['Name'].lower() for d in m.distributions()})))"
    )
    out = subprocess.run(  # noqa: S603
        ["docker", "run", "--rm", "--network", "none", tag, "python", "-c", code],  # noqa: S607
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    found = sorted(BENCHMARK_PACKAGES.intersection(out))
    write_json(
        ROOT / "stt-results" / "runtime-image-check.json",
        {"installed": out, "benchmark_packages_found": found},
    )
    log(f"runtime image: {len(out)} distributions, benchmark packages found: {found}")
    if found:
        raise SystemExit(1)


def host_report(_: argparse.Namespace) -> None:
    from sttbench import report  # noqa: PLC0415

    report.build(ROOT, DOCS)
    log("report: results.json and results-tables.md written")


def host_all(args: argparse.Namespace) -> None:
    host_fetch(args)
    if not (ROOT / "stt-corpus" / "index.json").exists():
        host_corpus(args)
    host_build(args)
    args.engine = None
    args.candidate = None
    args.skip_tune = False
    args.phase = "both"
    host_stt(args)
    host_diar(args)
    host_report(args)


def container(args: argparse.Namespace) -> None:
    models = Path("/data/models")
    if args.stage == "c-stt-accuracy":
        from sttbench import evaluate  # noqa: PLC0415

        evaluate.accuracy(
            args.engine,
            Path("/data/stt-corpus"),
            models,
            int(args.threads),
            Path("/data/stt-results"),
            args.tag,
            args.limit,
            args.snrs.split(",") if args.snrs else None,
            args.per_language,
        )
    elif args.stage == "c-stt-resources":
        from sttbench import evaluate  # noqa: PLC0415

        long_wav = Path("/data/long/long-60.wav")
        evaluate.resources(
            args.engine,
            Path("/data/stt-corpus"),
            long_wav,
            models,
            Path("/data/stt-results"),
            args.long_minutes,
            args.tag,
        )
    else:
        from diarbench import evaluate as de  # noqa: PLC0415

        corpus, out = Path("/data/diar-corpus"), Path("/data/diar-results")
        threads = int(args.threads)
        if args.stage == "c-diar-tune":
            de.tune(args.candidate, corpus, models, threads, out)
        elif args.stage == "c-diar-eval":
            de.evaluate(args.candidate, corpus, models, threads, out, args.tag, args.limit)
        else:
            de.resources(args.candidate, corpus, models, out, args.long_minutes, args.tag)


def main() -> None:
    import os  # noqa: PLC0415

    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument(
        "stage",
        choices=[
            "fetch",
            "corpus",
            "build",
            "stt",
            "diar",
            "report",
            "check-runtime",
            "all",
            "c-stt-accuracy",
            "c-stt-resources",
            "c-diar-tune",
            "c-diar-eval",
            "c-diar-resources",
        ],
    )
    p.add_argument("--engine", choices=ENGINE_IDS)
    p.add_argument("--candidate", choices=DIAR_CANDIDATES)
    p.add_argument("--tag", default="a")
    p.add_argument("--b-limit", type=int, default=40, help="clips in the determinism re-run")
    p.add_argument("--a-limit", type=int, help="diarization: 2 = conversations up to 5 min only")
    p.add_argument("--tags", default="a,b", help="accuracy runs to execute (b = determinism)")
    p.add_argument("--limit", type=int)
    p.add_argument("--per-language", type=int, help="STT accuracy: first N sentences per language")
    p.add_argument("--snrs", help="STT accuracy: comma-separated SNR subset, e.g. clean,10")
    p.add_argument("--long-minutes", type=float, default=60.0)
    p.add_argument("--phase", choices=["accuracy", "resources", "both"], default="both")
    p.add_argument("--skip-tune", action="store_true", help="diarization: reuse the dev tuning")
    p.add_argument("--only", nargs="*")
    p.add_argument("--threads", default=os.environ.get("BENCH_THREADS", "1"))
    args = p.parse_args()
    handlers = {
        "fetch": host_fetch,
        "corpus": host_corpus,
        "build": host_build,
        "stt": host_stt,
        "diar": host_diar,
        "report": host_report,
        "check-runtime": host_check_runtime,
        "all": host_all,
    }
    handlers.get(args.stage, container)(args)


if __name__ == "__main__":
    main()
