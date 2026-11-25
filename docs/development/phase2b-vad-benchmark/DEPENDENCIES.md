# VAD benchmark dependencies (Phase 2B WS5a, OD-29)

Benchmark-only. They live in the optional dependency group `vad-benchmark` in `services/audio/pyproject.toml`
(`dependencies` is unchanged), are installed only by the Dockerfile stage `vad-benchmark`, and are **not** in the
`runtime` or `test` images. Nothing here selects a candidate: selection is the user's (plan §13.4, OD-29).

Checked on 2026-11-21 from PyPI JSON metadata and the GitHub API **before** the install (`uv add --group vad-benchmark`).

## onnxruntime (MIT)

| Check | Result |
| --- | --- |
| Version locked | 1.32.0 (released 2026-11-13; previous 1.31.1 on 2026-10-26, 1.31.0 on 2026-10-09, 1.30.0 on 2026-09-10) |
| Licence | `MIT License` (wheel metadata; PyPI) |
| Wheel, Linux aarch64 cp312 (the image) | `onnxruntime-1.32.0-cp312-cp312-manylinux_2_28_aarch64.whl`, 23,196,724 bytes, SHA-256 `e36c187006e7a7c8b8d6d57f1a209dd63f52430dca6c282b177718ad6b841054` |
| Wheel, macOS arm64 cp312 (host) | `onnxruntime-1.32.0-cp312-cp312-macosx_14_0_arm64.whl` (not used by the benchmark; everything is measured in the container) |
| Installed size in the image | 63 MB for `onnxruntime/` (pybind state library 28.5 MB); whole `vad-benchmark` venv 150 MB vs 203 MB for the `test` venv (dev tools included) |
| Transitive dependencies (new) | `flatbuffers` 25.12.19 (Apache-2.0), `protobuf` 7.36.2 (BSD-3-Clause); `numpy` already present; `packaging` already present |
| Maintenance | Monthly releases, latest 8 days before the check |
| Security / privacy note | The 1.32.0 Linux wheel logs `telemetry_1ds.cc ... Failed to persist telemetry device ID` at `import onnxruntime` (before any API call can disable it), i.e. it contains a telemetry component. The benchmark also calls `onnxruntime.disable_telemetry_events()` and every benchmark container runs with `--network none`, so nothing can leave the container. If Silero is ever selected, this needs a security review before it enters the runtime image (the service has no egress, but the component should be confirmed inert) |

## Silero VAD ONNX model (MIT)

| Check | Result |
| --- | --- |
| Source | `snakers4/silero-vad`, GitHub (official) |
| Release / tag | `v6.2.3`, published 2026-09-23 (previous: v6.2.2 2026-09-17, v6.2.1 2026-02-24, v6.2 2025-11-06) |
| Tag commit | `5cd7945676eb32225748052e2e6a0580e4686a08` (`git/ref/tags/v6.2.3`) |
| File | `src/silero_vad/data/silero_vad.onnx` |
| URL (commit-pinned) | `https://raw.githubusercontent.com/snakers4/silero-vad/5cd7945676eb32225748052e2e6a0580e4686a08/src/silero_vad/data/silero_vad.onnx` |
| Size | 2,327,524 bytes |
| SHA-256 | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` |
| Git blob SHA-1 | `80c5592ef1f4c9ede3e357bbd02eb863358a6a9d` (equals the SHA the GitHub contents API reports for this path at the tag, so the download matches the repository object) |
| Licence | `LICENSE` at the tag is the MIT License, "Copyright (c) 2020-present Silero Team" (GitHub licence API: `MIT`). The licence covers the repository including the model file |
| Storage | `.local-benchmarks/models/silero_vad.onnx` (gitignored, not in the image). The harness verifies the SHA-256 before every load and refuses to run on a mismatch |
| Runtime | `onnxruntime` directly (`intra_op_num_threads=1`, `inter_op_num_threads=1`); the PyTorch `silero-vad` pip package and `torch` are not used |

## webrtcvad-wheels (MIT wrapper, BSD WebRTC)

| Check | Result |
| --- | --- |
| Version locked | 2.0.14.post1 (uploaded 2026-10-02; previous 2.0.14 on 2024-09-05, 2.0.13 on 2024-09-04) |
| Licence | `MIT` (wheel metadata) for the wrapper; the vendored WebRTC VAD sources are BSD-3-Clause upstream |
| Wheel, Linux aarch64 cp312 (the image) | `webrtcvad_wheels-2.0.14.post1-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.whl`, 86,403 bytes, SHA-256 `394af5aea41253b34e858f0f977a62f1c9fafeff7cc9adf71422e8431e68e80b` |
| Wheel, macOS arm64 cp312 | A wheel **does** exist (`webrtcvad_wheels-2.0.14.post1-cp312-cp312-macosx_11_0_arm64.whl`, 29,912 bytes), which corrects the plan's §13.1 "no macOS arm64 wheel found". The benchmark still runs only in the container |
| Installed size | under 1 MB (`_webrtcvad.cpython-312-aarch64-linux-gnu.so` plus a 1-file Python wrapper) |
| Maintenance | Releases in 2024-09 and a re-release in 2026-10; the upstream WebRTC VAD code is frozen (the wrapper is a thin fork of a 2017 original) |
| Transitive dependencies | none at runtime |

## Lock file effect

`uv.lock` gained 120 lines and lost none: the entries for `onnxruntime`, `webrtcvad-wheels`, `flatbuffers` and
`protobuf`, and a `vad-benchmark` group on `vip-audio-service`. The `build` stage runs `uv sync --locked --no-dev`, so
the new group is not installed unless asked for (`--group vad-benchmark`, only in the `vad-benchmark` stage).
