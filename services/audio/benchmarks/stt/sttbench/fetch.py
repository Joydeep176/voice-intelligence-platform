"""Download pinned models (host), verify hashes, pin new files in models.lock.json (TOFU)."""

from __future__ import annotations

import subprocess  # noqa: S404
import tarfile
from pathlib import Path

from .common import LOCK_JSON, MODELS_JSON, log, read_json, sha256_file, write_json


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    subprocess.run(  # noqa: S603
        ["curl", "-fL", "--retry", "3", "--retry-delay", "5", "-o", str(tmp), url],  # noqa: S607
        check=True,
    )
    tmp.replace(dest)


def _pin(lock: dict, key: str, path: Path, upstream: str | None) -> None:
    digest = sha256_file(path)
    if upstream and digest != upstream:
        raise RuntimeError(f"{key}: SHA-256 differs from the upstream-reported hash")
    if key in lock and lock[key]["sha256"] != digest:
        raise RuntimeError(f"{key}: SHA-256 differs from models.lock.json")
    lock[key] = {
        "sha256": digest,
        "size": path.stat().st_size,
        "upstream_verified": bool(upstream),
    }


def fetch(root: Path, only: list[str] | None = None) -> None:  # noqa: PLR0912
    reg = read_json(MODELS_JSON)["models"]
    lock = read_json(LOCK_JSON) if LOCK_JSON.exists() else {}
    for mid, spec in reg.items():
        if only and mid not in only:
            continue
        out = root / spec["dir"]
        out.mkdir(parents=True, exist_ok=True)
        for f in spec.get("files", []):
            dest = out / f["name"]
            if not dest.exists():
                _download(f["url"], dest)
            _pin(lock, f"{spec['dir']}/{f['name']}", dest, f.get("upstream_sha256"))
        if "archive" in spec:
            arc = spec["archive"]
            wanted = spec["extract"]
            if not all((out / n).exists() for n in wanted):
                tgz = root / "_archives" / Path(arc["url"]).name
                if not tgz.exists():
                    _download(arc["url"], tgz)
                if arc.get("upstream_sha256") and sha256_file(tgz) != arc["upstream_sha256"]:
                    raise RuntimeError(f"{mid}: archive hash differs from upstream-reported hash")
                with tarfile.open(tgz, "r:bz2") as t:
                    for m in t:
                        base = Path(m.name).name
                        if m.isfile() and base in wanted and Path(m.name).parts[-2:-1]:
                            src = t.extractfile(m)
                            if src is not None:
                                (out / base).write_bytes(src.read())
                missing = [n for n in wanted if not (out / n).exists()]
                if missing:
                    raise RuntimeError(f"{mid}: archive lacks {missing}")
            for n in wanted:
                _pin(lock, f"{spec['dir']}/{n}", out / n, None)
        write_json(LOCK_JSON, lock)
        log(f"fetch {mid}: ok")
