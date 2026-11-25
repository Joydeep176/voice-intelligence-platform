"""Install the pinned self-hosted inference models (ADR-0036 / ADR-0037) into a models directory.

    uv run --directory services/audio python scripts/fetch_models.py [--dest DIR] [--from DIR]

`--dest` defaults to `<repo>/.local-models` (gitignored), which Compose mounts read-only at
`/models`. A file is taken from `--from` (default: the C3 benchmark store `.local-benchmarks/
stt-models`, already hash-checked there) when present, otherwise downloaded from its commit- or
release-pinned URL. Every installed file is checked against its SHA-256 and size before it is
moved into place; the service checks them again at startup. Nothing is sent but the HTTP request:
no account, token or telemetry. Free, open licences only (see ADR-0036 / ADR-0037).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import shutil
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services/audio/src"))

from audio_service.domain.inference_models import (  # noqa: E402
    CAMPPLUS_EN_VOXCELEB,
    PYANNOTE_SEGMENTATION_3_0,
    SILERO_VAD_V6_2_3,
    WHISPER_SMALL_Q5_1,
    ModelFile,
)

# (pinned file, path inside the benchmark store, download source)
SOURCES: list[tuple[ModelFile, str, dict[str, str]]] = [
    (
        WHISPER_SMALL_Q5_1,
        "ggml/ggml-small-q5_1.bin",
        {
            "url": "https://huggingface.co/ggerganov/whisper.cpp/resolve/"
            "5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin"
        },
    ),
    (
        SILERO_VAD_V6_2_3,
        "../models/silero_vad.onnx",
        {
            "url": "https://raw.githubusercontent.com/snakers4/silero-vad/"
            "5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx"
        },
    ),
    (
        PYANNOTE_SEGMENTATION_3_0,
        "diar-segmentation/model.onnx",
        {
            "archive": "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
            "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
            "archive_sha256": "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
            "member": "sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
        },
    ),
    (
        CAMPPLUS_EN_VOXCELEB,
        "diar-embedding/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
        {
            "url": "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
            "speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx"
        },
    ),
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1 << 20):
            sha.update(chunk)
    return sha.hexdigest()


def ok(path: Path, model: ModelFile) -> bool:
    return (
        path.is_file() and path.stat().st_size == model.size and sha256_file(path) == model.sha256
    )


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "vip-fetch-models"})  # noqa: S310
    with urllib.request.urlopen(request, timeout=600) as response:  # noqa: S310 - pinned https URLs
        return response.read()


def fetch(model: ModelFile, source: dict[str, str]) -> bytes:
    if "url" in source:
        return download(source["url"])
    archive = download(source["archive"])
    if sha256_bytes(archive) != source["archive_sha256"]:
        raise SystemExit(f"{model.name}: archive hash mismatch")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:bz2") as tar:
        member = tar.extractfile(source["member"])
        if member is None:
            raise SystemExit(f"{model.name}: member missing from archive")
        return member.read()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--dest", type=Path, default=ROOT / ".local-models")
    parser.add_argument(
        "--from", dest="source", type=Path, default=ROOT / ".local-benchmarks/stt-models"
    )
    args = parser.parse_args()
    for model, store_path, source in SOURCES:
        target = args.dest / model.relpath
        if ok(target, model):
            sys.stdout.write(f"ok        {model.relpath}\n")
            continue
        local = args.source / store_path
        if ok(local, model):
            data, how = local.read_bytes(), "copied"
        else:
            data, how = fetch(model, source), "downloaded"
        if len(data) != model.size or sha256_bytes(data) != model.sha256:
            raise SystemExit(f"{model.name}: SHA-256 or size mismatch; nothing installed")
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp:
            tmp.write(data)
        shutil.move(tmp.name, target)
        target.chmod(0o644)
        sys.stdout.write(f"{how:<10}{model.relpath}\n")


if __name__ == "__main__":
    main()
