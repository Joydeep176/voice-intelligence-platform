"""Single entry point of the VAD candidate benchmark (Phase 2B WS5a, OD-29). Selects nothing.

Host, from the repository root (needs macOS `say` and Docker):

    uv run --directory services/audio python benchmarks/vad/run.py all

`all` = corpus (host) -> docker build of the `vad-benchmark` stage -> tune / evaluate (twice, for
determinism) / drift / resources in hardened containers -> report. Stages can be run on their own:

    corpus | tune | evaluate | drift | resources | report | all

The container stages run the same file with `--candidate silero|webrtc|baseline` (see README.md).
Nothing is downloaded except what DEPENDENCIES.md records; no speech or noise dataset is used.
"""

from __future__ import annotations

import argparse
import subprocess  # noqa: S404
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vadbench import common as c  # noqa: E402

CANDIDATES = ["silero", "webrtc", "baseline"]
IMAGE = "vip-vad-benchmark"
_PARTS = Path(__file__).resolve().parents
REPO = _PARTS[4] if len(_PARTS) > 4 else Path("/")  # noqa: PLR2004  (image: container stages only)
DEFAULT_ROOT = REPO / ".local-benchmarks"
DEFAULT_DOCS = REPO / "docs" / "development" / "phase2b-vad-benchmark"


def log(msg: str) -> None:
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def selected_params(results: Path, candidate: str) -> dict[str, Any]:
    tuning = c.read_json(results / f"tuning-{candidate}.json")
    params: dict[str, Any] = tuning["selected"]
    return params


def stage_corpus(args: argparse.Namespace) -> None:
    from vadbench import corpus  # noqa: PLC0415

    root = Path(args.corpus)
    index = (
        c.read_json(root / "index.json")
        if (root / "index.json").exists()
        else corpus.build_corpus(root)
    )
    manifest = {
        "environment": corpus.environment(),
        "seed": c.CORPUS_SEED,
        "settings": {
            "sample_rate": c.SAMPLE_RATE,
            "snrs": c.SNRS,
            "noise_types": c.NOISE_TYPES,
            "gap_range_s": c.GAP_RANGE_S,
            "reference_rule": {
                "relative_db_below_peak": c.REF_REL_DB,
                "fill_frames": c.REF_FILL_FRAMES,
                "min_speech_frames": c.REF_MIN_SPEECH_FRAMES,
            },
            "clean_floor_dbfs": c.CLEAN_FLOOR_DBFS,
            "scenes": c.SCENES,
            "utterances_per_scene": c.UTTERANCES_PER_SCENE,
            "dev_sentences_per_language": c.DEV_PER_LANGUAGE,
        },
        **index,
    }
    c.write_json(Path(args.docs) / "corpus-manifest.json", manifest)
    log(f"corpus: {len(index['mixtures'])} mixtures, {len(index['utterances'])} utterances")


def stage_tune(args: argparse.Namespace) -> None:
    from vadbench import evaluate  # noqa: PLC0415

    out = evaluate.tune(args.candidate, Path(args.corpus), Path(args.models))
    c.write_json(Path(args.out) / f"tuning-{args.candidate}.json", out)
    log(f"tune {args.candidate}: {out['selected']} objective={out['objective']:.4f}")


def stage_evaluate(args: argparse.Namespace) -> None:
    from vadbench import evaluate  # noqa: PLC0415

    params = selected_params(Path(args.out), args.candidate)
    out = evaluate.evaluate(args.candidate, params, Path(args.corpus), Path(args.models))
    c.write_json(Path(args.out) / f"evaluation-{args.candidate}-{args.tag}.json", out)
    log(f"evaluate {args.candidate} [{args.tag}]: {out['decisions_sha256'][:16]}")


def stage_drift(args: argparse.Namespace) -> None:
    from vadbench import evaluate  # noqa: PLC0415

    params = selected_params(Path(args.out), args.candidate)
    out = evaluate.drift(args.candidate, params, Path(args.corpus), Path(args.models))
    c.write_json(Path(args.out) / f"drift-{args.candidate}.json", out)
    log(f"drift {args.candidate}: done")


def stage_resources(args: argparse.Namespace) -> None:
    from vadbench import resources  # noqa: PLC0415

    params = selected_params(Path(args.out), args.candidate)
    out = resources.measure(args.candidate, params, Path(args.corpus), Path(args.models))
    c.write_json(Path(args.out) / f"resources-{args.candidate}.json", out)
    log(f"resources {args.candidate}: rtf={out['rtf_median']:.5f}")


def stage_report(args: argparse.Namespace) -> None:
    from vadbench import report  # noqa: PLC0415

    report.build(Path(args.out), Path(args.docs))
    log("report: results.json and README tables written")


def docker_run(stage: str, candidate: str, root: Path, extra: list[str] | None = None) -> None:
    cmd = [
        "docker",
        "run",
        "--rm",
        "--init",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--network",
        "none",
        "--tmpfs",
        "/tmp:size=16m,noexec,nosuid,nodev",  # noqa: S108
        "-v",
        f"{root / 'vad-corpus'}:/data/corpus:ro",
        "-v",
        f"{root / 'models'}:/data/models:ro",
        "-v",
        f"{root / 'vad-results'}:/data/results",
        IMAGE,
        "python",
        "benchmarks/vad/run.py",
        stage,
        "--candidate",
        candidate,
        "--corpus",
        "/data/corpus",
        "--models",
        "/data/models",
        "--out",
        "/data/results",
        *(extra or []),
    ]
    subprocess.run(cmd, check=True)  # noqa: S603, S607


def stage_all(args: argparse.Namespace) -> None:
    root = Path(args.root)
    (root / "vad-results").mkdir(parents=True, exist_ok=True)
    if not (root / "vad-corpus" / "index.json").exists():
        args.corpus = str(root / "vad-corpus")
        stage_corpus(args)
    subprocess.run(  # noqa: S603
        [  # noqa: S607
            "docker",
            "build",
            "-f",
            str(REPO / "services/audio/Dockerfile"),
            "--target",
            "vad-benchmark",
            "-t",
            IMAGE,
            str(REPO / "services/audio"),
        ],
        check=True,
    )
    for cand in CANDIDATES:
        docker_run("tune", cand, root)
    for cand in CANDIDATES:
        for tag in ("a", "b"):
            docker_run("evaluate", cand, root, ["--tag", tag])
        docker_run("drift", cand, root)
    for cand in CANDIDATES:
        docker_run("resources", cand, root)
    args.out = str(root / "vad-results")
    stage_report(args)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument(
        "stage", choices=["corpus", "tune", "evaluate", "drift", "resources", "report", "all"]
    )
    p.add_argument("--candidate", choices=CANDIDATES)
    p.add_argument("--root", default=str(DEFAULT_ROOT))
    p.add_argument("--corpus", default=str(DEFAULT_ROOT / "vad-corpus"))
    p.add_argument("--models", default=str(DEFAULT_ROOT / "models"))
    p.add_argument("--out", default=str(DEFAULT_ROOT / "vad-results"))
    p.add_argument("--docs", default=str(DEFAULT_DOCS))
    p.add_argument("--tag", default="a")
    args = p.parse_args()
    if args.stage not in {"corpus", "report", "all"} and not args.candidate:
        p.error("--candidate is required for this stage")
    {
        "corpus": stage_corpus,
        "tune": stage_tune,
        "evaluate": stage_evaluate,
        "drift": stage_drift,
        "resources": stage_resources,
        "report": stage_report,
        "all": stage_all,
    }[args.stage](args)


if __name__ == "__main__":
    main()
