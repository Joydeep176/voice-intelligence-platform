# Phase 2B WS1 verification record (audio-service foundation)

Measured on 2026-11-21 in the audio image built from `services/audio/Dockerfile` (Docker Desktop Engine 29.9.3,
linux/arm64, kernel `7.0.14-linuxkit`, Docker default seccomp profile, no custom profile). No secrets are recorded.
Reproduce with `pnpm audio:test:container` (the tests print `FFMPEG_VERSION=`, `LANDLOCK_ABI=` and
`FD_PROTOCOL_PCM_BYTES=` with `-s`) and `AUDIO_SERVICE_TEST_DOCKER=1 uv run --directory services/audio pytest tests/test_compose_hardening.py`.

## FFmpeg in the image

| Item | Result |
| --- | --- |
| `ffmpeg -version` (first line) | `ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers` |
| `ffprobe -version` (first line) | `ffprobe version 7.1.5-0+deb13u1 Copyright (c) 2007-2026 the FFmpeg developers` |
| Python | 3.12.16, container user uid 10001 (`audiosvc`) |

## `fd` protocol with `-protocol_whitelist fd,pipe` (plan §6.1 assumption [A])

- **The plan's `-i fd:3` form does not work in FFmpeg 7.1.5.** FFmpeg refuses it:
  `Doesn't support pass file descriptor via URL, please set it via -fd {num}` / `fd:3: Invalid argument`.
- **Working form:** `-protocol_whitelist fd,pipe -fd <n> -i fd:` (and the same for `ffprobe`), where `<n>` is the inherited
  descriptor number. `ffmpeg -h protocol=fd` lists the `-fd` and `-blocksize` AVOptions. `audio_service.domain.ffmpeg_args`
  builds exactly this form and refuses caller-supplied `-i`, `-fd`, `-protocol_whitelist`, `-filter_complex`, `lavfi`,
  `concat`, `hls`, `dash`.
- **Seekability:** a generated MP4/AAC file with its `moov` atom at the end (the muxer default, so the demuxer must seek)
  decoded to 32 694 bytes of 16 kHz mono s16le (about 1.02 s) through an inherited, seekable, read-only descriptor
  (`O_RDONLY|O_NOFOLLOW|O_CLOEXEC`), under Landlock. `ffprobe` read the same file (codec `aac`, duration about 1 s).
- **Allow-list control:** with `-protocol_whitelist fd,pipe`, a plain path input (`-i /tmp/...`) fails with a "not on
  whitelist" error. Stderr was classified in the test only and is never logged.
- Because `pass_fds` keeps descriptor numbers and `-fd` takes any number, the child's input descriptor is not fixed at 3.
  `subprocess` forces `close_fds=True` when `pass_fds` is given; the child therefore sees exactly fds 0, 1, 2 and the input
  descriptor (verified with `ls /proc/<pid>/fd`).
- Test audio is generated with `-f lavfi` **inside the tests only**.

## Landlock (plan §6.2, proposed control: implemented and measured)

| Item | Result |
| --- | --- |
| Kernel exposes Landlock | **Yes, ABI 8** (`landlock_create_ruleset` with `LANDLOCK_CREATE_RULESET_VERSION`) |
| Docker default seccomp blocks `landlock_*` / `prctl(NO_NEW_PRIVS)` | **No**: ruleset creation, `add_rule` and `restrict_self` succeed under `--cap-drop ALL --security-opt no-new-privileges` |
| Ruleset | Handles all filesystem rights of the ABI; read/execute only beneath `/usr`, `/lib`, `/lib64` (if a real directory), `/etc`; on ABI >= 4 handles TCP bind/connect with no allow rules. `/dev/null`, `/proc`, `/sys`, `/tmp`, `/storage`, `/app` are not allowed |
| FFmpeg works confined with that minimal ruleset | **Yes** (decode and probe above ran with `landlock.enforced == true`) |
| Confined child reads a canary in `/tmp` | **Denied** (the same read works unconfined; `/etc/hostname` works confined) |
| Confined child reads `/app/pyproject.toml`, `/proc/1/status`, lists `/tmp` | **Denied** (`/storage` is absent in the test container; the Compose mount case is not exercised by a canary test yet) |
| Confined child connects to a loopback TCP listener | **Denied** (the same connect succeeds unconfined and is accepted by the listener) |
| `landlock.enforced` in `/v1/capabilities` | `true`: set only after a startup self-test child fails to read a canary (`SandboxRunner.verify_enforcement`) |
| Metadata (`stat`) | Not governed by Landlock: `ls -d` of a denied directory still succeeds. Tests assert on reads and listings |
| Removing the control | Mutation check: with `landlock_restrict_self` disabled, 6 Landlock tests fail |

Limits that remain: Landlock does not cover UDP; it restricts the child only, not the Python service; the result is for
this kernel and may differ on other hosts (the service reports the measured state at startup).

**Corrected (review remediation):** this section originally said `AUDIO_SERVICE_LANDLOCK=required` makes children refuse
to start "where it is unsupported". That only covered a missing ruleset: a kernel where the ruleset exists but does not
confine would still have run children. Now `required` refuses every child until the startup self-test has observed
enforcement (canary read, TCP, and on ABI >= 6 signal and abstract-socket scoping); see `VERIFICATION_REMEDIATION.md`
section 3. Abstract UNIX sockets and signals to the parent are covered from ABI 6 (scoping), not before.

## Compose hardening as applied (`docker inspect` of the running container)

`CapDrop=[ALL]`, no `CapAdd`, `SecurityOpt` contains `no-new-privileges`, `PidsLimit=64`, `ReadonlyRootfs=true`,
`Memory=512 MiB`, `NanoCpus=1e9`, `Tmpfs[/tmp]` has `noexec,nosuid,nodev,size=16m`, not privileged; port `8001/tcp` bound
to `127.0.0.1` only; network `<project>_vip-audio-dev` is a `bridge`, `Internal=false`, no masquerade option; mounts
exactly `/storage/recordings` (read-only) and `/storage/derived` (read-write); container logs do not contain the token;
a short token makes the service exit naming only `AUDIO_SERVICE_TOKEN`.

Compose notes: Compose 5.7.0 rejected `pids_limit` together with `deploy.resources.limits` ("can't set distinct values on
`pids_limit` and `deploy.resources.limits.pids`"), so the limit is set as `deploy.resources.limits.pids: 64` (verified in
`docker inspect`). `init: true` was added so orphaned FFmpeg grandchildren are reaped (zombies count against `pids`).
Docker Desktop bind mounts map ownership: uid 10001 could create a directory in a host directory with mode 0700 owned by
the macOS user (checked once with a throwaway directory; Linux hosts will need matching ownership).

## Other findings

- `apt-get install ffmpeg` on `python:3.12-slim-trixie` now creates a system group named `audio`, so the previous
  `useradd --system --uid 10001 audio` failed and the old Dockerfile could not build. The user is now `audiosvc`.
- Unit tests exercising these controls pass on the host except the `container`-marked ones, which are skipped there with a
  reason.
