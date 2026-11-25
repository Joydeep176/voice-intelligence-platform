# Audio service dependencies

Runtime dependencies are pinned by `uv.lock` (`uv sync --locked`). Adding one needs approval and an entry here.

## NumPy 2.x (added in Phase 2B WS3)

Approved scope: the only new runtime dependency of WS3. Used for the block arrays yielded by the streamed decoder
(`audio_service.domain.decoder`: float32 native blocks, int16 canonical blocks as read-only views of the raw bytes) and,
since WS4 the measurements computed on them (`domain/measurements.py`: float64 sums, `einsum`, `np.sort`; no SciPy, no librosa, no new dependency). Added with `uv add "numpy>=2,<3"`; `uv.lock` gained only the
NumPy entry (32 lines).

| Check | Result |
| --- | --- |
| Version locked | 2.5.5 (upload time in `uv.lock`: 2026-11-15) |
| Licence | `License-Expression: BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` from the installed wheel's metadata. The package licence is BSD-3-Clause; the extra identifiers cover bundled components (pocketfft, libdivide, dragon4, highway, x86-simd-sort, pythoncapi-compat, SVML). All permissive; no copyleft |
| Maintenance | Mainstream NumFOCUS project; a release on 2026-11-15 and a 2.x line current at this commit (from the lock's upload times, not a statement about future releases) |
| Wheel, Linux aarch64, Python 3.12 (the image) | `numpy-2.5.5-cp312-cp312-manylinux_2_27_aarch64.manylinux_2_28_aarch64.whl` is in `uv.lock`; the image has no compiler, so this wheel is what was installed in the build |
| Wheel, macOS arm64, Python 3.12 (development hosts) | `numpy-2.5.5-cp312-cp312-macosx_11_0_arm64.whl` (and `macosx_14_0_arm64`) in `uv.lock`; the host test suite runs against it |
| Import RSS delta, measured in the hardened test container (`--read-only --cap-drop ALL --memory 512m`) | 15.6 MiB, three runs of `python -c "import numpy"` (RSS 12.4 MiB before, 28.0 MiB after; `/proc/self/status` `VmRSS`) |
| Installed size | 40 MB for `numpy/` in the image's virtualenv |
| Security notes | Pure data container here: no `pickle`, no `np.load`, no file or network I/O; arrays are created only with `np.frombuffer` on bytes read from FFmpeg's stdout |

Reproduce the RSS number: a three-line script printing `VmRSS` before and after `import numpy`, run with
`docker run --rm --read-only --cap-drop ALL --memory 512m vip-audio-test python <script>` (image from
`pnpm audio:test:container`'s build step).
