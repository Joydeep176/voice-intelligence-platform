# Phase 2B · audio processing foundation — technical plan (DRAFT, revision 4)

**Status (updated 2026-11-21): implemented.** The user authorised execution of this revision on 2026-11-21. The D-2B decisions
were implemented under that execution brief; their **formal acceptance (ADRs / register rows) is pending the user's
Phase 2B review** and is not claimed here. Authoritative outcome: `PHASE2B_COMPLETION.md`; current project state: `docs/PROJECT_STATUS.md`. This document is kept as
historical planning evidence (revision 4 text preserved; dated status notes added). Original revision-4 status follows.

**Original status: implementation-readiness revision for the user's approval. Implementation had not started.** Revision 4
(2026-11-21, Stage 1 Opus pass) applies the four requested corrections: FFmpeg security boundary (§6), networking
(§7, D-2B-08 **recorded as ADR-0035, Accepted**), timestamp semantics (§11), VAD evaluation and selection (§13). It also
records the hardware correction (D-2B-17, applied on the user's instruction as an ADR-0034 amendment). All other
D-2B decisions remain unapproved until the user approves this revision. No code, dependency, model, dataset or
migration was changed. Revisions 1–3 are superseded by this text.

Control-status labels (used in §6, §7): **[impl]** present in code or configuration today · **[verified]** demonstrated
by an executed experiment or test with saved evidence · **[planned]** to be implemented in a named workstream ·
**[proposed]** needs the user's approval · **[residual]** risk accepted and documented, not mitigated.
**Final labels (closure pass, 2026-11-22):** the status cells in §6.1, §6.2 and §7 now show the final status first and keep
the revision-4 label after "rev. 4 status:" as history. [verified] means implemented and covered by an executed test or
measurement; it does not mean the governing D-2B decision is formally accepted.

Evidence labels: **[M]** measured on this machine (method stated) · **[R]** requirement (SRS, accepted ADR, project rule)
· **[E]** estimate, to be confirmed by benchmark · **[A]** assumption, to be verified during implementation ·
**[C]** computed from stated numbers. Decision IDs **D-2B-01 … D-2B-20** are defined once, in §15.

Constraints [R]: ADR-0034 (zero spending); hardware **Apple M1, 8 GB unified memory, 512 GB SSD** (user, 2026-11-21);
scope `docs/development/PHASE2B_SCOPE.md`.

---

## 1. Current state (verified in source at `b407c38`, 2026-11-21; Graphify built from `b407c38`)

| Area | State |
| --- | --- |
| Audio service | FastAPI skeleton: health probes and `POST /v1/handshake`; deps fastapi, pydantic, uvicorn. No FFmpeg use, storage access, task API **or request authentication** (`AUDIO_SERVICE_TOKEN` exists in no source file; ADR-0035 requires it, Workstream 1) |
| Upload validation | API magic-byte sniff (`apps/api/src/recordings/media-signature.ts`): wav, flac, ogg, mp4 (`ftyp`), webm/matroska (EBML), mp3 (ID3 / frame sync) — the source for the FFmpeg demuxer allow-list (§6) |
| Migrations | `0000_enable_pgvector`, `0001_foundation`; next is `0002_audio_processing` |
| Audio container | `python:3.12-slim-trixie` + Debian `ffmpeg` (version unverified; image not built locally [M]), non-root uid 10001, read-only rootfs, `/tmp` tmpfs, cgroup limit **512 MB memory, 1.0 CPU**, Compose `--profile audio`, port published as `127.0.0.1:8001:8001` |
| Networking | Compose uses its default network only [M]. API reaches Python via `AUDIO_SERVICE_URL` (`http://127.0.0.1:8001`) [M]. Orchestrator has no audio URL. Target per ADR-0035 (§7) |
| Contracts | `audio-service.ts` v1 + Pydantic mirror + shared fixtures |
| API / orchestrator | `AudioServiceClient` (ready, handshake); orchestrator: foundation-check worker only, no `@vip/db`, no LangGraph |
| Database | `recordings` has `duration_ms`, `sample_rate`, `channels`, `validation_error`, statuses `validating`/`valid`/`invalid`. No preprocessing tables |
| Storage | `LocalStorageService`: root `STORAGE_LOCAL_ROOT` (default `<repo>/.local-storage`), `KEY_PATTERN`, temp + rename, 0600/0700, `moveObject` |
| Design | ADR-0002, ADR-0023, ADR-0018 provisional until a prototype; ADR-0015, ADR-0019, ADR-0010, ADR-0007 accepted. LLD §2.3/§3.1/§4/§5 sketch the task API, the `audio-task` step-job and canonical mono 16 kHz lossless audio |

Phase 2B is the prototype ADR-0002/0023/0018 call for; its results confirm or revisit them.

## 2. Architecture (summary of D-2B-01 … D-2B-09)

```
Browser ─REST─▶ apps/api ─enqueue IDs─▶ BullMQ `audio-processing` ─▶ apps/orchestrator (coordinator; no LangGraph)
   ▲ polls snapshot      │ reads                                         │ config record + hash (ADR-0015), lifecycle,
   └──────────── Postgres ◀── all DB writes (probe, preprocessing, segments, measurements, progress)
                                                                          │ `audio-task` step-job: submit / poll / cancel
                                                                          ▼  HTTP + bearer token (loopback)
                                        audio container: Python service (no DB/Redis) → FFmpeg/ffprobe children (sandboxed)
                                          reads  recordings/<ws>/<rec>/original     (read-only mount)
                                          writes derived/<ws>/<rec>/<configHash>/…  (read-write mount; disk temp)
```

| Responsibility | Owner |
| --- | --- |
| Upload trigger, start/retry/cancel endpoints, snapshot API | apps/api |
| Config record + hash, version reuse, job lifecycle, retries, timeouts, progress persistence, all DB writes | apps/orchestrator |
| Probe, decode, measurements, canonical audio, VAD, segments, waveform peaks, artefact writes | services/audio |
| Schemas + Pydantic mirrors + fixtures | packages/contracts |
| Migration and repositories | packages/db |
| Interpretation of measurements | A1, future phase (§8) |

Processing is **recording-scoped** (ADR-0015 preprocessing versions). Runs stay `created`; no run is shown as executed.

## 3. End-to-end flow

1. Upload completes → API enqueues `audio-processing {recordingId}`; recording `uploaded → validating` (D-2B-15).
2. **Probe**: sandboxed ffprobe (§6) → container, codec, start time, sample rate, channels, bit rate, header duration;
   limits checked (D-2B-18, D-2B-20). A bounded trial decode classifies `full | partial | none`. `none` → `invalid` +
   code; else `valid`, and `duration_ms`, `sample_rate`, `channels`, `media_probe` filled.
3. Coordinator calls `GET /v1/capabilities` (tool versions incl. VAD model SHA-256), builds the canonical config record,
   hashes it, and upserts `audio_preprocessings` (reuses a `succeeded` row with the same hash).
4. **Preprocess** (one task, sequential passes, **10 s blocks**):
   - Pass A, native rate per channel: peak, clipping runs, DC offset, inter-channel correlation (before resampling or
     downmix, which would smooth clipping); FFmpeg `astats` and `ebur128` for standardised loudness.
   - Pass B, canonical: mono 16 kHz s16 written to the canonical file while computing level series, silence ratio,
     noise-floor estimate, waveform peaks and VAD frames.
   - VAD regions → segments → per-segment measurements.
5. Result (metadata + keys + manifest) → coordinator persists in one transaction; `succeeded`; audit event.
6. Browser polls the snapshot (§10). Poor audio never stops processing (FR-3.4); only "no decodable audio" fails.

## 4. Resources: memory and CPU (D-2B-20)

### 4.1 Preliminary measurements — **not** the target environment

| Measurement | Value | Environment |
| --- | --- | --- |
| Service baseline (FastAPI + uvicorn + app loaded) | 47 MB peak RSS [M] | target Python 3.12.16 venv, **macOS host** (not the container) |
| NumPy import | +20 MB [M] | host Python 3.10 + NumPy 1.26.4 (**non-target**) |
| 1 h of 48 kHz stereo analysed in **30 s** blocks with float64 + FFT temporaries | 187 MB peak, 9.4 s compute [M] | same non-target environment, synthetic data |
| Docker VM host cost with the 4 GB setting | 389 MB [M] | `ps` RSS |
| Swap | 1.21 GB used, 25,855 pageouts [M] | `sysctl`, `memory_pressure` |
| Other host load | Node dev processes ≈ 1.1 GB; other apps ≈ 1.5 GB [M] | `top` |

These numbers only guide the design. **Acceptance uses target-environment benchmarks**: the built audio image (Python
3.12, final locked dependencies), measured inside the container with cgroup v2 `memory.peak` [A: available in the
Docker Desktop kernel], which includes FFmpeg children. macOS RSS figures are not used for acceptance.

### 4.2 Memory design

| Component (whole container) | Estimate |
| --- | --- |
| Python + FastAPI + uvicorn + app | ~47 MB [M, host] |
| NumPy | ~20–30 MB [E] |
| Buffers with **10 s blocks, float32, in-place operations** | 40–70 MB [E, scaled from the 30 s measurement] |
| onnxruntime + Silero (only if selected) | 30–60 MB [E] |
| FFmpeg child (one at a time) | 20–60 MB [E] |
| **Expected peak** | **≈ 160–260 MB [E]** |

- **Single memory threshold (mandatory): container `memory.peak` ≤ 384 MB** (75 % of the unchanged 512 MB limit) on the
  4 h benchmark recording.
- The 512 MB limit and the **Docker Desktop memory setting stay unchanged**. No evidence supports changing Docker: the
  VM costs 389 MB of host memory today [M]; the benchmark records VM host RSS before, during and after processing, and
  only new evidence would justify a proposal.
- Benchmark procedure: record machine state; Vite dev/preview servers stopped and unrelated apps closed.

### 4.3 CPU (reconciled)

The container has **1.0 CPU** (CFS quota). Starting configuration: FFmpeg `-threads 1`, `-filter_threads 1`;
onnxruntime `intra_op=1, inter_op=1`; `OMP_NUM_THREADS=1`, `OPENBLAS_NUM_THREADS=1`; one task at a time. More threads
under a 1-CPU quota would only contend [E]. The benchmark also measures a **comparison variant** (2 CPUs, 2 FFmpeg
threads) for information; any change needs approval (D-2B-20).

## 5. Storage (D-2B-04) — authoritative design

| Aspect | Design |
| --- | --- |
| Root | One directory. API `STORAGE_LOCAL_ROOT`; Python `AUDIO_SERVICE_STORAGE_ROOT` = same directory (host) or the container mount |
| Addressing | Node sends **keys**, never paths. Python validates with the same `KEY_PATTERN` + resolved-path prefix check; rejects absolute paths, `..` and symlinks leaving the root |
| Permissions | Python **reads** only `recordings/<ws>/<rec>/original`; **writes** only under `derived/<ws>/<rec>/<configHash>/`. Node never writes `derived/` (future deletion job removes it) |
| Container mounts | `<root>/recordings` → `/storage/recordings` **read-only**; `<root>/derived` → `/storage/derived` read-write. Nothing else of the host is mounted (no repo, no `.env`) |
| Host development (`uv run`) | Same rules enforced in code only [A: acceptable for development] |
| Workspace isolation | Node builds keys from rows of the authenticated workspace; tasks carry `workspaceId` and `recordingId`; Python rejects keys whose path segments differ |
| **Temporary files (authoritative)** | **Disk only**: per-task directory `derived/<ws>/<rec>/<configHash>/.tmp-<taskId>/`. **No audio or intermediate data in tmpfs** (container `/tmp` is memory-backed and counts against the 512 MB limit [A]); `/tmp` stays for incidental small files with a size cap (16 MB). FFmpeg reads input by descriptor and writes to pipes (§6) |
| Atomic publication | Files written in the temp directory, flushed, fsynced, renamed into place; `manifest.json` (file list + SHA-256) written last as the completion marker; Node persists only after task success |
| Cleanup | Temp directory removed in `finally`; on startup Python removes stale `.tmp-*` directories under `derived/` only |
| Disk bound | Free-space precheck ≥ 3 × expected canonical size; at most one task's temp data at a time |
| Idempotency | Output keys depend only on recording + config hash; a re-run writes identical bytes |
| Modes | 0600 files, 0700 directories; uid 10001 vs macOS user on bind mounts to be verified [A] |
| Portability | Python `StorageBackend` (`open_read`, `open_write_atomic`, `exists`, `delete_prefix`) with a local backend; Node `StorageService` gains `derived` keys; S3 later (OD-48) swaps backends only |

## 6. FFmpeg and untrusted-media security boundary (D-2B-09) — correction A

**Threat model.** Every upload is untrusted. Two distinct threats: (T1) *feature abuse* — a crafted file makes FFmpeg
open other local files or network resources through legitimate demuxer features (HLS/DASH playlists, `concat`, image
sequences, MP4/MOV external data references, `subfile`, `tee`), disclosing other recordings or application files;
(T2) *memory-corruption exploitation* — a parser bug gives code execution inside the FFmpeg child. Command-line options
address T1 only. **No FFmpeg option is a sandbox against T2**; T2 is bounded by OS-level controls (uid, mounts,
capabilities, rlimits, cgroups, Landlock) and the remainder is documented as residual risk.

*(Revision-4 text, written before implementation:)* Nothing in this section is implemented in Python code today; only the container settings marked [impl] exist.

**Implementation status (2026-11-21).** Every §6.1–6.2 control below that is labelled [planned] or [proposed] is now
implemented and covered by tests that fail when the control is removed (`services/audio/VERIFICATION_WS1.md`,
`VERIFICATION_WS3.md`, `VERIFICATION_REMEDIATION.md`). Landlock is **[verified]** on Docker Desktop 4.99.0 / kernel
7.0.14-linuxkit (ABI 8: filesystem, TCP, signal and abstract-socket scoping) and Compose runs with
`AUDIO_SERVICE_LANDLOCK=required` (children refuse to start if the self-test fails). Corrections from review:
the `mjpeg`/`png` decoders **are** opened by FFmpeg's stream-info pass for attached cover art (residual risk contained by
Landlock, rlimits, `-max_alloc` and the cgroup); children killed by a signal map to `RESOURCE_EXHAUSTED`/`TIMEOUT`, never to a
file property; an overall task deadline (interim formula, OD-10) bounds each task. Residual T2 risk is limited to UDP from
an exploited child on the development bridge (ADR-0035) and kernels without Landlock.

### 6.1 Input and parsing controls (T1)

| Control | Specification | Status |
| --- | --- | --- |
| No path or URL reaches FFmpeg | Python opens the original read-only (`O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK`, regular files only), validates the key and resolved path (§5), and passes the descriptor with `pass_fds` (it keeps its inherited number). **FFmpeg 7.1.5 refuses `-i fd:3`; the working form is `-fd <n> -i fd:`** (ffprobe accepts the same) | [verified] WS1, `services/audio/VERIFICATION_WS1.md`: seekable MP4/AAC with trailing `moov` decoded through an inherited fd under Landlock; WS3 uses it |
| Protocol allow-list | `-protocol_whitelist fd,pipe`; `file`, `http(s)`, `tcp`, `udp`, `rtp`, `concat`, `subfile`, `tee`, `data`, `crypto` never allowed | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3; test: crafted inputs that reference each protocol fail with a mapped code |
| Demuxer allow-list | `-f <demuxer>` from the magic-byte class (never the extension or declared MIME), plus `-format_whitelist wav,mp3,mov,mp4,m4a,3gp,3g2,mj2,flac,ogg,matroska,webm`; playlist-type demuxers (`hls`, `dash`, `concat`, `image2`, `ffconcat`) can never be selected | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3 |
| Codec allow-list | `-codec_whitelist` restricted to audio decoders: PCM family (`pcm_s16le, pcm_s24le, pcm_s32le, pcm_f32le, pcm_u8`, big-endian variants), `mp3float`/`mp3`, `aac`, `alac`, `flac`, `vorbis`, `opus`/`libopus`; video, subtitle and data streams discarded (`-vn -sn -dn`) | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3; exact decoder names fixed against `ffmpeg -decoders` of the image |
| MP4/MOV references | `-enable_drefs 0` and `-use_absolute_path 0` explicitly | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3; test with a dref pointing at a canary file |
| Probe bounds | `-probesize 5M`, `-analyzeduration 10M` (µs), ffprobe JSON capped at 256 KiB, `-max_alloc 268435456` (largest single allocation); reject > 8 channels, > 192 kHz, declared duration > limit (D-2B-18) before decoding | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3 |
| Decode classification | Decoder errors counted (stderr pattern classes) and output samples counted; `full | partial | none` with `decodedUntilMs`; never padded to the header duration; never silently truncated | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3 |
| Error output | `-hide_banner -nostats -loglevel error`, no `-report`; stderr read into a 64 KiB bounded buffer, mapped to an error code, then discarded; **never logged or persisted** (it can contain file metadata) | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS3; test asserts logs contain no stderr text |

### 6.2 Process and OS controls (T1 and T2)

| Control | Specification | Status |
| --- | --- | --- |
| Non-root container user | uid 10001 | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [impl] Dockerfile |
| Read-only root filesystem | `read_only: true` | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [impl] Compose |
| Container memory / CPU | 512 MB, 1.0 CPU cgroup limits (include children) | [verified] (limits: Compose hardening test; behaviour under the limit: `docs/development/phase2b-resources/`) — rev. 4 status: [impl] Compose; behaviour under the limit [planned] WS9 benchmark |
| Mounts | Only `<root>/recordings` → `/storage/recordings` **read-only** and `<root>/derived` → `/storage/derived` read-write; no repo, no `.env`, no other host path | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1 |
| Capabilities and privilege | `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, Docker default seccomp kept, `deploy.resources.limits.pids: 64` (Compose 5.7 rejects `pids_limit` alongside `deploy`), `init: true` (reaps orphaned grandchildren); `/tmp` tmpfs `size=16m,noexec,nosuid,nodev` | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1; verified by `docker inspect` plus an in-container test that `NET_RAW` is absent |
| Clean environment | Children get only `PATH=/usr/bin:/bin`, `LC_ALL=C`; `close_fds=True` except fd 3; stdin `/dev/null` (`-nostdin`); `AUDIO_SERVICE_TOKEN` and every other variable absent | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1; test reads `/proc/<child>/environ` |
| Process group | `start_new_session=True`; on timeout or cancel `SIGTERM` to the group, `SIGKILL` after 2 s; reaped; verified no survivors | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1; test kills a hung child (`-f lavfi` is not allowed in production, so the test uses a deliberately slow input) |
| rlimits per child | `RLIMIT_CPU` (from the task timeout), `RLIMIT_FSIZE = 0` (children write only to pipes, so any file write fails), `RLIMIT_NOFILE = 64`, `RLIMIT_CORE = 0`. Applied in a pre-exec step from a single executor thread, or via util-linux `prlimit` without a shell (choice is an implementation detail, WS1). `RLIMIT_AS` not used (spurious failures with large virtual reservations); memory is bounded by the cgroup and `-max_alloc` | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1 |
| Wall-clock timeouts | Per child: probe 60 s; decode 120 s + 0.5 × duration (D-2B-20) | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS1/WS3 |
| Disk | Children cannot write files (`RLIMIT_FSIZE = 0`); Python writes the canonical WAV with a byte budget (`duration × 32 000 B/s + header`, aborts beyond it) after a free-space precheck (§5) | [verified] (test fails when the control is removed; `services/audio/VERIFICATION_*.md`) — rev. 4 status: [planned] WS4 |
| **Landlock confinement of children** | Unprivileged Linux LSM, applied in the child before exec via `ctypes` syscalls (no new dependency): filesystem access limited to read-only `/usr`, `/lib`, `/etc/ld.so.*`; no access to `/storage`, `/app` or `/proc/1`; the already-open input fd stays usable. On ABI ≥ 4 also denies TCP `bind`/`connect`, which blocks child TCP egress even on the development bridge | [verified] (Docker Desktop 4.99.0, ABI 8; `required` in Compose; formal acceptance of D-2B-09 pending the user) — rev. 4 status: [proposed] D-2B-09; conditional on WS1 verifying that the linuxkit kernel exposes Landlock and Docker's default seccomp profile allows the `landlock_*` syscalls [A]. If unavailable, T2 residual risk below applies unchanged |
| Network | Children: no network protocols allowed (§6.1). Container: development egress possible (ADR-0035) | §7 |

### 6.3 Residual risks (documented, not mitigated)

| Risk | Detail | Status |
| --- | --- | --- |
| T2 without Landlock | A code-execution exploit in FFmpeg runs as uid 10001 and can read **every** original under the read-only `/storage/recordings` mount (all workspaces) and write under `/storage/derived`. Per-task mounts or a separate uid would need privileges the container does not have | [residual] unless Landlock is verified |
| T2 egress in development | On the development bridge an exploited child could open UDP sockets (Landlock does not cover UDP) and, without Landlock, TCP connections | [residual] ADR-0035 |
| Python process | Python itself does not parse media (only PCM from pipes and bounded ffprobe JSON); a Python compromise would expose the token | [residual] low |

### 6.4 Malicious and adversarial media tests (WS9; fixtures generated synthetically)

Renamed HLS playlist and DASH manifest; `ffconcat` list; MP4 with an external data reference pointing at a canary file;
image-sequence pattern names; `subfile:`/`file:` URLs embedded in metadata; truncated, zero-length and header-only files;
wrong magic for the declared type; polyglot (valid WAV header + MP4 box); huge declared sizes and durations; 255-channel
and 768 kHz headers; oversized ID3/metadata; a file that decodes forever (slow input); seeded mutation fuzzing of valid
files (fixed seeds, bounded count). **Pass:** canary never read (canary file placed in `/storage/recordings` of another
workspace and an access-time / Landlock-denial check), no network attempt (Landlock denial or packet capture on the
bridge), time and memory within limits, mapped error code, no stderr or file content in logs, originals' SHA-256
unchanged. Each control in §6.1–6.2 has at least one test that fails if the control is removed.

## 7. Networking and service discovery (D-2B-08 — ADR-0035, Accepted) — correction B

Evidence: `phase2b-network-verification/README.md` (Docker Desktop 4.99.0, Engine 29.9.3, Apple M1; three runs, saved
outputs). Decision: ADR-0035.

| Setting | Development (API and orchestrator on macOS) | Future all-in-Compose |
| --- | --- | --- |
| Network | Normal user-defined bridge (`vip-audio-dev`) | Audio service on an `internal: true` network **only** |
| Python bind | `0.0.0.0:8001` inside the container (needed for publishing); host `uv run`: `127.0.0.1:8001` | `0.0.0.0:8001` inside the container |
| Port publishing | `127.0.0.1:8001:8001` only. [verified] loopback publishing works and is not reachable on the LAN IPv4 (configs B/C) | None. [verified] publishing from an internal network silently creates no binding (config A) |
| Discovery | `AUDIO_SERVICE_URL=http://127.0.0.1:8001` for API **and** orchestrator (new orchestrator setting) | `http://audio-service:8001` via Compose DNS; API and orchestrator dual-homed. [verified] config D |
| Egress from the audio container | **Possible.** [verified] the default bridge reached every probed external target; disabling masquerading did not block egress and is **not** used. Limited only by application controls (§6.1 protocol allow-list, no network code; Landlock TCP denial for children if verified, §6.2) | Blocked for every probed IPv4 path [verified, config A]. IPv6 and host-gateway reachability **not tested** — required checks at that topology's acceptance |
| Authentication (OD-23b → ADR-0035) | Bearer `AUDIO_SERVICE_TOKEN` (≥ 32 chars, required, no default, constant-time compare, never logged, absent from children) on every route except `/health/live` | Mechanism OD-23c (Open, with OD-48) |
| Status | [verified] (`tests/phase2b-e2e/` scenario 8; Compose hardening tests) — rev. 4 status: [planned] WS1: Compose network, token settings, API and orchestrator client header, tests (missing/wrong token → 401; token absent from logs and child environment) | Not built in 2B |

**Implementation status (2026-11-21):** the development column is implemented and verified (`tests/phase2b-e2e/` scenario 8: loopback-only binding, 401 without/with a wrong token, token absent from logs). The all-in-Compose column is not built.

**Claim discipline:** no document may state that the development topology blocks egress. The verification script is
re-run after Docker Desktop upgrades.

## 8. Measurement ownership (D-2B-02)

| Python audio service (deterministic) | A1 Audio Quality (future agent) |
| --- | --- |
| Numbers with units (§9) | Interpretation: `good / degraded / poor`, flags with kind, time range, severity |
| Measurement parameters (block size, clipping level, silence threshold) are part of the hashed config: *how to measure* | Judging thresholds in A1's `rule_version` |
| Estimates labelled `estimate` | Explanations and transcription recommendations |
| No categories, scores or recommendations | Never recomputes signal measurements |
| Persisted by the coordinator in `audio_measurements` (per preprocessing version) | Reads them; writes only `audio_diagnostics` / `audio_diagnostic_flags` |

ADR-0019 and ADR-0015 already support this; only DATABASE_DESIGN §2 ("A1 writes `audio_measurements`") and LLD §2.3/§4
step 4 conflict. Recommendation: **a new ADR** amending those two documents. No approved ADR changes.

## 9. Measurements and dependencies (D-2B-11)

| Measurement | Tool |
| --- | --- |
| RMS, peak, crest factor, DC offset | NumPy (blocks); FFmpeg `astats` cross-check |
| Clipping count, ratio, run lengths; limiter plateaus | NumPy on native-rate samples; `astats` flat factor |
| Integrated loudness, loudness range, true peak (EBU R128) | FFmpeg `ebur128` |
| Silence ratio | NumPy block RMS vs configured threshold |
| Noise floor; speech vs non-speech level difference | NumPy percentiles, labelled `estimate` (true SNR needs a clean reference) |
| Spectral flatness/centroid (optional) | NumPy FFT |
| Inter-channel correlation | NumPy |
| Waveform peaks | NumPy, canonical pass |

librosa or SciPy would be needed only for mel spectrograms, MFCCs, chroma, onset strength, pitch (pYIN), spectral
contrast, HPSS, constant-Q or Python-side resampling — none required here; resampling is FFmpeg's. Harmonic distortion
on speech is not defensible without a reference and is not provided. **NumPy only; librosa deferred** (deviation from
the HLD baseline list).

## 10. Progress (D-2B-07) — one mechanism

| Step | Behaviour |
| --- | --- |
| Python | In-memory task state per block: `stage` (`probe, decode, measure, vad, segment, write`), `fraction`, `processedMs` |
| Orchestrator (`audio-task` step-job, ADR-0018) | Polls every 2 s; writes `audio_preprocessings.progress` when the stage changes, the fraction moves ≥ 1 % or 5 s pass |
| API | `GET /recordings/{id}/processing` reads the database snapshot only |
| Browser | Polls every 2 s while `queued`/`running`; stops on `succeeded`/`failed`/`cancelled`; pauses while hidden |
| States | `queued → running(+stage) → succeeded | failed{code, retryable} | cancelled`; "Cancelling" while `cancel_requested_at` is set and status is `running`; "No update received" if `progress.updatedAt` is older than 60 s |
| Cancellation | API sets `cancel_requested_at` → orchestrator calls `DELETE /v1/tasks/{id}` on its next poll → Python stops at the next block boundary, kills the FFmpeg process group, removes temp files → `cancelled` |
| Not in 2B | SSE, WebSockets, QueueEvents to the browser (OD-16 stays Proposed for the run phase) |

## 11. Timestamp semantics — correction C

### 11.1 Four timelines

| Timeline | Definition | Unit | Where recorded |
| --- | --- | --- | --- |
| **S — source media** | Presentation timestamps of the selected audio stream as the container declares them: stream `time_base`, `start_time`, packet PTS, edit lists, encoder delay / priming and padding metadata | stream ticks / seconds | `recordings.media_probe.timeline.source` (from ffprobe) |
| **D — decoded (native rate)** | Samples FFmpeg emits at the native rate after applying edit lists and gapless trimming. `d = 0` is the first presented sample; sample *k* ↔ `k / fs_native` s | native samples | per-pass sample counts in the result; not stored as audio |
| **C — canonical (16 kHz mono)** | The stored canonical WAV. Sample *n* ↔ `n / 16 000` s. Produced from D by `aresample` with `first_pts=0` and `async` gap filling, so **sample index tracks presentation time**; filled gaps are synthetic silence and listed | canonical samples; ms = n / 16 | `audio_preprocessings.timeline` (new column, §12) |
| **Segment positions** | Half-open `[start, end)` on **C**, snapped to whole milliseconds (multiples of 16 samples), so `start_ms`/`end_ms` are exact canonical sample positions | ms on C | `audio_segments` |

All downstream consumers (A1, A2) address audio on **C**. Mapping to S: `t_S = t_C + sourceOffsetMs`, where
`sourceOffsetMs` = the stream's presentation start after edit-list and priming handling, valid only where
`mappingStatus` (below) permits. Resampling D → C introduces no time shift beyond resampler phase (≤ 1 canonical
sample; FFmpeg compensates filter delay [A: verified by tone-burst tests]); downmix is per sample.

### 11.2 Mapping record (`audio_preprocessings.timeline`, jsonb)

```
{ schemaVersion, nativeSampleRate, decodedSamplesNative, canonicalSamples,
  source: { timeBase, startTimeTicks, startTimeMs, editListPresent: true|false|"unknown",
            encoderDelaySamples|null, paddingSamples|null, gaplessInfo: "lame"|"itunsmpb"|"edit_list"|"codec_preskip"|"none"|"unknown",
            headerDurationMs|null },
  sourceOffsetMs, decodeClass: "full"|"partial"|"none", decodedUntilMs|null,
  gaps: [{ startMs, durationMs, kind: "timestamp_gap_filled" }],          // on C; synthetic silence
  overlapsTrimmed: [{ atMs, durationMs }],
  decodeErrors: { count, firstAtMs|null },                                // packets the decoder rejected
  mappingStatus: "exact"|"offset_applied"|"approximate"|"uncertain",
  mappingErrorBoundMs|null, reasons: [code…] }
```

| `mappingStatus` | Meaning | Typical case |
| --- | --- | --- |
| `exact` | C ↔ S is sample-accurate; no gaps, no decoder errors, offset 0 | PCM WAV, FLAC |
| `offset_applied` | Accurate relative to the container's declared offset / edit list / gapless metadata, which FFmpeg applied | MP4/AAC with edit list, MP3 with LAME/Xing info, Opus with pre-skip |
| `approximate` | Linear but with a known bound (`mappingErrorBoundMs`), e.g. decoder delay not described by the file | MP3 without gapless info (≈ 1 frame bound), VBR without TOC (duration only) |
| `uncertain` | Accurate mapping cannot be established: missing or non-monotonic PTS, gaps filled, partial decoding, decoder errors | damaged or streamed recordings |

Rules: (1) never report higher precision than the status allows — the snapshot API returns `mappingStatus` and
`mappingErrorBoundMs` beside every timestamp set; (2) **gaps** are filled with silence so C stays aligned, recorded in
`gaps`, and segments overlapping a filled gap carry a `containsSyntheticGap` flag in the result manifest; (3) **missing
packets / decoder errors** are counted with the first position; status becomes `uncertain`; (4) **partial decoding**:
C covers only `[0, decodedUntilMs)`, `decodeClass = partial`, header duration kept separately, nothing padded or
truncated silently; (5) the **decoded sample count** is the authoritative duration (VBR header durations may differ).

**As implemented (WS3, `services/audio/VERIFICATION_WS3.md`, `docs/development/phase2b-timestamps/`):** `codec_preskip`
added for Opus pre-skip; for LAME MP3 `sourceOffsetMs` subtracts FFmpeg's reported start time when it equals the removed
priming (raw value kept in `source.startTimeMs`); gap tolerance is half the previous packet duration (≥ 1 ms; one long
block for Vorbis); `ERROR_BOUND_GAPLESS_LOSSY_MS = 2.0` is an engineering value calibrated on a small sample (max measured
0.80 ms); `editListPresent` is `"unknown"` for MOV without evidence. **Known limits:** silence inserted for frames the
decoder dropped without a timestamp jump is not listed in `gaps` (record is `uncertain` with an error count); truncation
of MP3 without Xing/LAME and of Ogg Vorbis/Opus is not detectable from the file (status not `uncertain`, but
`decodedUntilMs` is correct).

### 11.3 Validation (separate for lossless and lossy)

Synthetic tone bursts (and clicks) at known sample positions, encoded with the image's FFmpeg into each container/codec,
with and without leading offsets, edit lists, missing gapless metadata and injected timestamp gaps / dropped packets.

| Class | Formats | Criterion |
| --- | --- | --- |
| Lossless | WAV PCM (16/24/32-bit, 8–192 kHz), FLAC | **Mandatory:** onsets on C within 1 ms; `mappingStatus = exact` |
| Lossy | MP3 CBR (with / without LAME tag), MP3 VBR (with / without Xing), M4A/AAC (with edit list), Ogg Vorbis, Ogg Opus, WebM Opus | **Measured and reported per format**; proposed target ±10 ms (needs approval); status must be `offset_applied` or `approximate` with a bound that contains the measured error |
| Damaged | gaps injected, packets dropped, truncated tail | status `uncertain`; gaps listed at the right positions (± 10 ms); `decodedUntilMs` correct |

## 12. Database migration inventory (D-2B-05) — one additive migration `0002_audio_processing`

**Status (2026-11-22): created, Opus-reviewed and applied to the development database on 2026-11-21 after a `pg_dump`
backup.** The tables below are the revision-4 design; the as-built schema (authoritative: `DATABASE_DESIGN.md` §4,
`packages/db/drizzle/0002_audio_processing.sql`) also has `audio_segments.contains_synthetic_gap`, lifecycle-consistency
CHECKs and UPDATE-blocking triggers on `audio_segments` and `audio_measurements`. Formal acceptance of D-2B-05 is pending the user.

**New enum**

| Enum | Values |
| --- | --- |
| `preprocessing_status` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |

**Changes to an existing table**

| Table | Change | Purpose |
| --- | --- | --- |
| `recordings` | column `media_probe jsonb NULL` + CHECK `media_probe IS NULL OR jsonb_typeof(media_probe) = 'object'` | Container, codec, bit rate, start time, header duration, decode class, warnings, probe tool versions |
| `recordings` | unique index `recordings_id_workspace_uq (id, workspace_id)` | Target for composite workspace FKs |
| `recordings` | (no schema change) fills `duration_ms`, `sample_rate`, `channels`, `validation_error`, `status` | Basic probe values already have columns |

**New table `audio_preprocessings`** (designed in DATABASE_DESIGN §4; lifecycle columns added)

| Column | Type / constraint |
| --- | --- |
| `id` | uuid PK default random |
| `workspace_id` | uuid NOT NULL → `workspaces(id)` RESTRICT |
| `recording_id` | uuid NOT NULL; composite FK (`recording_id`, `workspace_id`) → `recordings(id, workspace_id)` ON DELETE CASCADE |
| `config_hash` | text NOT NULL, CHECK `~ '^[0-9a-f]{64}$'` |
| `hash_algorithm` | text NOT NULL DEFAULT `'sha256'` |
| `config` | jsonb NOT NULL |
| `tool_versions` | jsonb NOT NULL |
| `status` | `preprocessing_status` NOT NULL DEFAULT `'queued'` |
| `progress` | jsonb NULL |
| `attempt` | integer NOT NULL DEFAULT 0, CHECK `>= 0` |
| `error` | jsonb NULL (`{code, retryable}` only) |
| `cancel_requested_at` | timestamptz NULL |
| `normalized_uri` | text NULL |
| `canonical_sha256` | text NULL, CHECK hex 64 |
| `canonical_duration_ms` | bigint NULL, CHECK `>= 0` |
| `vad` | jsonb NULL |
| `timeline` | jsonb NULL, CHECK object — timeline mapping record (§11.2); added in revision 4 |
| `artifacts` | jsonb NULL |
| `started_at`, `finished_at` | timestamptz NULL, CHECK `finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at` |
| `created_at`, `updated_at` | timestamptz NOT NULL |

Indexes/constraints: unique (`recording_id`, `config_hash`); unique (`id`, `workspace_id`); index
(`workspace_id`, `recording_id`, `created_at DESC`).

**New table `audio_segments`** (designed; `workspace_id` added per the project rule; immutable after insert)

| Column | Type / constraint |
| --- | --- |
| `id` | uuid PK |
| `workspace_id` | uuid NOT NULL → `workspaces(id)` RESTRICT |
| `preprocessing_id` | uuid NOT NULL; composite FK (`preprocessing_id`, `workspace_id`) → `audio_preprocessings(id, workspace_id)` CASCADE |
| `index` | integer NOT NULL, CHECK `>= 0` |
| `start_ms`, `end_ms` | bigint NOT NULL, CHECK `0 <= start_ms AND start_ms < end_ms` |
| `overlap_start_ms`, `overlap_end_ms` | integer NOT NULL DEFAULT 0, CHECK `>= 0` |
| `speech_ms` | bigint NOT NULL, CHECK `>= 0` |
| `storage_uri` | text NULL (time ranges into the canonical file in 2B) |

Indexes/constraints: unique (`preprocessing_id`, `index`); unique (`id`, `preprocessing_id`) (target of the measurements composite FK); index (`preprocessing_id`, `start_ms`).

**New table `audio_measurements`** (designed; `workspace_id`, `source`, `schema_version`, `series_uri` added; immutable)

| Column | Type / constraint |
| --- | --- |
| `id` | uuid PK |
| `workspace_id` | uuid NOT NULL → `workspaces(id)` RESTRICT |
| `preprocessing_id` | uuid NOT NULL; composite FK (`preprocessing_id`, `workspace_id`) → `audio_preprocessings(id, workspace_id)` CASCADE |
| `segment_id` | uuid NULL; composite FK (`segment_id`, `preprocessing_id`) → `audio_segments(id, preprocessing_id)` CASCADE (segment must belong to the same version) |
| `source` | text NOT NULL, CHECK in (`original_decoded`, `canonical`) |
| `schema_version` | text NOT NULL |
| `measurements` | jsonb NOT NULL, CHECK object |
| `series_uri` | text NULL |
| `service_version` | text NOT NULL |
| `created_at` | timestamptz NOT NULL |

Indexes/constraints: partial unique (`preprocessing_id`, `source`) WHERE `segment_id IS NULL`; partial unique
(`preprocessing_id`, `segment_id`, `source`) WHERE `segment_id IS NOT NULL`; index (`preprocessing_id`).

**Totals:** 1 enum; 3 tables; 1 new column; 4 composite FKs (+ 3 single-column FKs to `workspaces`); 5 unique
constraints/indexes for identity and composite targets (`recordings` ×1, `audio_preprocessings` ×2, `audio_segments` ×2),
2 partial unique indexes, 3 secondary indexes. `pipeline_runs` is not changed (`preprocessing_id` arrives with runs).

**Why no jobs table:** one preprocessing version is one unit of work; its lifecycle (`status`, `progress`, `attempt`,
`error`, timestamps) lives on that row; BullMQ holds transient job state; history is in `audit_events`; a different
config creates a new version row, so prior attempts stay visible. A jobs table would duplicate state and invite
divergence. Run-level stage tracking (`pipeline_stage_runs`, designed) belongs to the run phase.

**Rationale:** additive only, no data rewrite, the 23 existing recordings untouched, rollback drops new objects;
DATABASE_DESIGN updated in the same change (project rule). Deviations from DATABASE_DESIGN listed in D-2B-05.

## 13. VAD evaluation and selection (D-2B-10) — correction D

### 13.1 Candidates

| | Silero VAD (ONNX) | WebRTC VAD | Signal baseline |
| --- | --- | --- | --- |
| Method | Small stateful neural model, 32 ms frames at 16 kHz [A] | GMM classifier, 10/20/30 ms, aggressiveness 0–3 | Energy + spectral flatness + adaptive noise floor + hangover (NumPy) |
| Licence | MIT (model and code; re-verified at download) | MIT wrapper + BSD WebRTC | project code |
| Runtime | `onnxruntime` (MIT) + vendored ONNX model pinned by SHA-256; **not** the PyTorch pip package | `webrtcvad-wheels` 2.0.14 | NumPy |
| ARM64 | Linux aarch64 and macOS arm64 wheels [A: verify at install] | Linux aarch64 wheel; no macOS arm64 wheel found → benchmark only in the container | any |
| Memory / CPU | 30–60 MB [E] | < 5 MB [E] | negligible [E] |
| Multilingual / noise | Multilingual training, noise-robust per vendor [A]; Hindi–English unverified | Language-independent; weak in non-stationary noise [A] | Language-independent; weak in noise [A] |
| Maintenance | Active | Fork of a 2017 original | ours |

Excluded: PyTorch-based models (memory on 8 GB), TEN VAD (licence conditions).

### 13.2 Metrics (all reported; none used alone)

Frame level (10 ms, test split): precision, recall, **false-positive rate**, **false-negative rate**, F1. Boundary:
onset and offset error (median, p95) against reference spans. Post-segmentation (same segmenter for all
candidates; D-2B-19 parameters): speech coverage and **non-speech inclusion** (share of segment time that is reference non-speech).
Resources, in the container: real-time factor (median of 3), CPU seconds per audio hour, container `memory.peak`.
Long-file drift on 60 / 120 min files; determinism across two runs.

### 13.3 Conditions

Languages: English, Hindi, Hindi–English code-switched (MUCS) and consented internal Hinglish if available.
SNR: clean / 20 / 10 / 5 / 0 dB with stationary and non-stationary noise; gaps 0.2–5 s; 16 kHz; seeded mixtures;
dev/test split; thresholds tuned on dev only with identical post-processing.

### 13.4 Selection rule (proposed; the user selects)

1. **Hard constraints:** fits the memory gate (§4.2) and 1-CPU budget with RTF ≤ 0.05; deterministic; licence clean.
2. **Primary quality:** F1 at 10 dB and 5 dB SNR on the test split, reported per language — a candidate must not be
   worst in any language.
3. **Guards against recall-only selection:** FPR and non-speech inclusion must not exceed the signal baseline's at the
   same SNR; boundary p95 reported and compared.
4. Ties broken by fewer dependencies (baseline < WebRTC < Silero).

The benchmark report (`docs/development/phase2b-vad-benchmark/`) presents every metric per language and SNR. **Work
stops for the user's selection** before any VAD becomes a runtime dependency (OD-29).

## 14. Acceptance criteria

**Mandatory (pass/fail)**

| Area | Criterion |
| --- | --- |
| Originals | SHA-256 and inode of every original unchanged across all tests, including failures and cancellations |
| Canonical audio | Mono, 16 kHz, s16; duration equals the decoded sample count |
| Determinism | Same input + config + tool versions → identical canonical SHA-256, measurements and segments |
| Measurements | RMS/peak within 0.1 dB and exact clipping counts on analytic synthetic signals |
| Timestamps, lossless | WAV/FLAC tone-burst onsets on C within 1 ms; `mappingStatus = exact` (§11.3) |
| Timestamps, honesty | Lossy and damaged inputs never reported as `exact`; reported bound contains the measured error (§11.3) |
| Memory | Container `memory.peak` ≤ 384 MB on the 4 h benchmark; growth ≤ 10 % across 5 consecutive jobs |
| Cancellation | Cancelled status reached, FFmpeg process group gone and temp directory removed within 10 s |
| Recovery | After a service restart mid-task, resubmission completes within the retry bound with identical outputs |
| Hardening | All §6.4 malicious-media tests pass; each §6.1–6.2 control has a test that fails when the control is removed |
| Networking | Token required (401 without); token absent from logs and child environment; port bound to 127.0.0.1 only |
| VAD process | Benchmark executed and every §13.2 metric reported per language and SNR before selection |
| Regression | All existing suites green; frontend bundle budgets unchanged |

**Targets requiring baseline measurements and the user's approval**

| Area | Proposed target |
| --- | --- |
| VAD quality | Speech coverage ≥ 98 % at 10 dB SNR; FPR and boundary-error thresholds set from the baseline |
| Timestamps, lossy formats | ±10 ms |
| Cancellation latency | ≤ 5 s |
| Throughput | e.g. ≤ 10 % of real time; set from the baseline |

## 15. Decision register

Type: **A** architecture · **P** user-configurable parameter (initial values; OD-10) · **I** implementation detail
(informational; changes reported, no approval needed).

| ID | Type | Proposed decision | Rationale | Depends on | Approval |
| --- | --- | --- | --- | --- | --- |
| D-2B-01 | A | Ownership per §2: API / orchestrator coordinator / Python; recording-scoped processing; no LangGraph or agents | ADR-0002, ADR-0015, ADR-0019; avoids fake run execution | — | Yes |
| D-2B-02 | A | Measurement boundary §8, recorded as a new ADR amending DATABASE_DESIGN §2 and LLD §2.3/§4 | ADR-0019/0015 consistent; design text conflicts | D-2B-01 | Yes |
| D-2B-03 | A | Processing runs in the audio container; Homebrew FFmpeg on the host optional (free) | FFmpeg only in the image [M]; enforced limits | — | Yes |
| D-2B-04 | A | Storage design §5 (keys, read-only originals, `derived/` writes, disk temp, mounts) | Integrity, isolation, portability | D-2B-03 | Yes |
| D-2B-05 | A | Migration inventory §12 (deviations: `workspace_id` on segments/measurements, composite FKs, lifecycle columns, nullable segment `storage_uri`, `source`, `media_probe`, **`timeline` (rev. 4)**) | Project database rule; workspace isolation | D-2B-01 | Yes |
| D-2B-06 | A | Internal contract v2 and browser endpoints §16 | Framework-independent contract (ADR-0002) | D-2B-01 | Yes |
| D-2B-07 | A | Progress via database snapshot polling §10; SSE deferred (OD-16) | One mechanism | D-2B-06 | Yes |
| D-2B-08 | A | Networking and bearer-token auth §7 | Network experiment evidence | D-2B-03 | **Decided by the user; recorded as ADR-0035 (Accepted); OD-23b resolved for development, OD-23c Open** |
| D-2B-09 | A | FFmpeg security boundary §6 (T1 input controls; T2 OS controls incl. `cap_drop`, `no-new-privileges`, `RLIMIT_FSIZE=0`, **Landlock if verified**; residual risks §6.3; tests §6.4) | Untrusted media (SEC-10) | D-2B-03 | Yes |
| D-2B-10 | A | VAD selection process §13 (OD-29); selection itself after results | Benchmark before choice | D-2B-14 | Yes (process now, selection later) |
| D-2B-11 | A | Dependencies: NumPy; onnxruntime + Silero model only if selected; `webrtcvad-wheels` benchmark-only; librosa deferred | §9; ADR-0034 | D-2B-10 | Yes |
| D-2B-12 | A | Canonical audio mono 16 kHz s16 WAV; no loudness or dynamics processing by default | Lossless, simple random access, no speech degradation | — | Yes |
| D-2B-13 | A | Waveform peaks during the canonical pass, served by time range (OD-39) | No extra decode | D-2B-06 | Yes |
| D-2B-14 | A | Datasets §17 (OD-18), downloaded only after approval | Licensed, permitted use | — | Yes |
| D-2B-15 | A | Trigger: automatic after upload for new recordings; explicit start for the existing 23 | No silent backfill | D-2B-06 | Yes |
| D-2B-16 | A | Minimal frontend: real processing status and metadata on recording detail | Honest progress in UI | D-2B-07 | Yes |
| D-2B-17 | A | ADR-0034 hardware correction §18 | Factual accuracy | — | **Applied on the user's instruction (2026-11-21) as an ADR-0034 amendment** |
| D-2B-18 | P | Limits: max duration 4 h (alternatives 3 h / 6 h); upload 2 GiB unchanged; ≤ 8 channels; ≤ 192 kHz | FR-1.1/NFR-1 need > 2 h; disk/time bounded | — | Yes (OD-10) |
| D-2B-19 | P | Segmentation: 1–30 s; split on silence ≥ 500 ms; merge gaps < 300 ms; padding 200 ms; overlap 1 s only on forced splits | Later STT windows; stitching | D-2B-10 | Yes (OD-10) |
| D-2B-20 | P | Resources: container 512 MB / 1.0 CPU (unchanged); 1 task; FFmpeg and ONNX 1 thread; timeouts probe 60 s, preprocess 120 s + 0.5 × duration; memory gate ≤ 384 MB; Docker setting unchanged | §4 | D-2B-03 | Yes (OD-10) |

Implementation details (type I, no approval): 10 s blocks; float32 processing; 2 s orchestrator and browser poll;
progress write throttle (≥ 1 % or 5 s); temp directory naming; idempotency key `<recordingId>:<configHash>:<taskType>`;
error-code names; free-space factor 3×; `/tmp` 16 MB cap.

## 16. Contracts (sketch)

Internal (Node → Python; contract version 2; `Authorization: Bearer`): `GET /v1/capabilities`;
`POST /v1/tasks { type: probe|preprocess, idempotencyKey, workspaceId, recordingId, input: { originalKey, outputPrefix }, config }`
→ `202 { taskId }`; `GET /v1/tasks/{id}` → status, progress, result or `error { code, retryable }`;
`DELETE /v1/tasks/{id}`. Error codes: `UNSUPPORTED_FORMAT`, `CORRUPT_MEDIA`, `NO_DECODABLE_AUDIO`,
`DURATION_LIMIT_EXCEEDED`, `RESOURCE_LIMIT_EXCEEDED`, `TIMEOUT`, `CANCELLED`, `STORAGE_ERROR`, `INTERNAL_ERROR`.

Browser (new, workspace-scoped, never exposing Python): `GET /recordings/{id}/processing`,
`POST /recordings/{id}/processing`, `POST /recordings/{id}/processing/cancel`,
`GET /recordings/{id}/processing/segments?fromMs&toMs`, `GET /recordings/{id}/processing/waveform?fromMs&toMs&pairsPerSecond`.

## 17. Datasets (D-2B-14) — rechecked, nothing downloaded

| Kind | Dataset | Licence | Conditions | Use |
| --- | --- | --- | --- | --- |
| Speech | Mozilla Common Voice | CC0-1.0 (data) | Some releases add terms (no speaker identification, no re-hosting); accept the exact release terms | Hindi, English |
| Speech | Google FLEURS | CC BY 4.0 | Attribution | Hindi (`hi_in`), English |
| Speech | LibriSpeech (OpenSLR 12) | CC BY 4.0 | Attribution | English |
| Speech | MUCS 2021 sub-task 2 (OpenSLR 104) | CC BY-SA 4.0 | Attribution; ShareAlike on redistribution (none planned) | Hindi–English code-switching (technical tutorials) |
| Speech | Consented internal recordings | ADR-0004 | Internal only | Natural Hinglish |
| Noise | MUSAN (OpenSLR 17) | CC BY 4.0 headline; per-file public domain / CC | Per-file attribution | Noise subset |
| Noise | DEMAND (Zenodo 1227121) | CC BY-SA 3.0 | Attribution; ShareAlike on redistribution | Environmental noise, 48 kHz |

Non-commercial-licensed sets excluded. Licences re-checked at download; corpus outside the repo with a manifest.

## 18. Hardware correction (D-2B-17) — applied 2026-11-21

Applied on the user's instruction, preserving history: ADR-0034 Context, Decision and Consequences corrected to Apple M1,
8 GB unified memory, 512 GB SSD, with an **Amendment** section quoting the original M2/16 GB wording; HLD OD-46 row;
`.claude/skills/add-provider-adapter/SKILL.md`; `PHASE2B_SCOPE.md`. The decision itself is unchanged.

## 19. Implementation sequence (revision 4; one Sonnet developer at a time; user review after every workstream)

Every workstream: Graphify context passed in the prompt (no rediscovery); `step → verify` list stated first; docs and
tests in the same change; `verify-change` run; result presented; **stop for the user's review** before the next one.
Opus review follows workstreams tagged `[opus-review-follows]`.

| # | Workstream | Agent (model) | Owned files | Decisions | Verify |
| --- | --- | --- | --- | --- | --- |
| 0 | ADRs for the decisions approved with this revision (measurement boundary; OD-10 parameters; OD-39 peaks; OD-18 corpus); DATABASE_DESIGN / LLD / API_SPECIFICATION text | main session (Opus), `record-architecture-decision` | `docs/architecture/**` | D-2B-02, -13, -14, -18…-20 | doc consistency grep |
| 1 | Service foundation: contracts v2 (+ Pydantic mirror, fixtures); bearer auth; capabilities; in-memory single-slot task executor; Python storage backend + key validation; **subprocess runner** (clean env, fds, process group, rlimits, timeouts); Compose network/mounts/hardening; image build; in-container verification of FFmpeg version, `fd` protocol and Landlock | backend-engineer (Sonnet) `[backend] [opus-review-follows]` | `services/audio/**`, `packages/contracts/src/audio-service*`, `infra/docker/compose.yaml`, `apps/api/src/audio/**` (client header only), `.env.example` (variable names only) | -04, -06, -08, -09 | `pnpm audio:test`, contracts tests, API client tests, container checks |
| 2 | Migration `0002_audio_processing`, Drizzle schema, repositories, DATABASE_DESIGN | backend-engineer (Sonnet) `[backend] [opus-review-follows]` + security-reviewer (Opus, `[data-integrity]`) | `packages/db/**`, `docs/architecture/DATABASE_DESIGN.md` | -05 | db unit + integration; migrate on a copy of the dev DB; existing rows unchanged |
| 3 | Sandboxed probe, streamed decode, decode classification, **timeline mapping (§11)**; NumPy added (after licence/wheel/memory check) | backend-engineer (Sonnet) `[backend] [opus-review-follows]` | `services/audio/src/audio_service/{probe,decode,timeline}/**` + tests | -09, -11, -18 | pytest incl. lossless/lossy tone-burst suite |
| 4 | Measurements (passes A/B), canonical WAV, waveform peaks | backend-engineer (Sonnet) `[backend]` | `services/audio/src/audio_service/{measure,canonical,peaks}/**` + tests | -12, -13 | analytic-signal tests |
| 5a | VAD benchmark harness, corpus manifest, mixtures, run in the container, report | backend-engineer (Sonnet) `[backend]`; main session verifies | `services/audio/benchmarks/**`, `docs/development/phase2b-vad-benchmark/**` (corpus outside the repo) | -10, -14 | report reproducible from manifest + seeds |
| — | **User selects the VAD (OD-29)** → ADR | main session | — | -10, -11 | — |
| 5b | Selected VAD adapter (dependency added only now) | backend-engineer (Sonnet) | `services/audio/src/audio_service/vad/**` | -10 | pytest |
| 6 | Segmentation on C | backend-engineer (Sonnet) | `services/audio/src/audio_service/segment/**` | -19 | pytest incl. long files |
| 7 | Coordinator in the orchestrator (`audio-processing` queue, `audio-task` step-job, config hash, persistence, progress, retries, cancel, stuck-job sweep); API endpoints; upload trigger | backend-engineer (Sonnet) `[backend] [opus-review-follows]` | `apps/orchestrator/src/**`, `apps/api/src/{processing,recordings}/**`, `packages/contracts/src/processing*` | -01, -07, -15, -20 | Jest unit + integration (needs infra) |
| 8 | Recording detail: real processing status, metadata, start/retry/cancel | frontend-engineer (Sonnet) `[frontend]` | `apps/web/src/**` (recording detail + processing hooks only) | -16 | Vitest, axe, bundle budgets |
| 9 | Consolidated tests: §6.4 malicious media, integration, recovery, M1 resource benchmarks | test-engineer (Sonnet) `[tests] [opus-review-follows]` | test files only | — | full suites |
| 10 | Architecture review; security + data-integrity review; performance review | architecture-reviewer, security-reviewer (Opus); performance-reviewer (Sonnet) | read-only | — | findings resolved or recorded |
| 11 | Graphify incremental update; completion record; PROJECT_STATUS | main session (Opus) + documentation-agent (Sonnet `[docs-technical]`) | `docs/development/PHASE2B_COMPLETION.md`, `docs/PROJECT_STATUS.md` | — | user acceptance |

## 20. Risks

- Host memory pressure [M: swap in use]; benchmarks need a controlled machine state.
- FFmpeg `fd` protocol behaviour in the container's version is unverified [A]; fallback limits MP4 handling. *Resolved (WS1): FFmpeg 7.1.5 needs `-fd N -i fd:`; seekable MP4 works through an inherited fd.*
- Silero accuracy on Hindi–English code-switching unverified [A]. *Partly addressed: measured on synthetic TTS only (`phase2b-vad-benchmark/`); real-speech accuracy still unverified (datasets OD-18).*
- WebRTC VAD needs a source build on the macOS host; benchmark in the container. *Resolved: benchmarked in the container (`vad-benchmark` stage).*
- Bind-mount ownership between uid 10001 and the macOS user unverified [A]. *Resolved on Docker Desktop (WS1, WS9 E2E); Linux hosts may need matching ownership.*
- Development egress from the audio container is possible [verified, ADR-0035]; only application controls limit it.
- *Resolved (WS1, remediation): Landlock ABI 8 is available and enforced on Docker Desktop 4.99.0; Compose requires it.* Revision-4 text: Landlock availability under Docker Desktop's kernel and seccomp profile unverified [A]; without it, an FFmpeg
  code-execution exploit can read every original (§6.3).
- Common Voice downloads require an account (an external service receiving personal details) — the user decides;
  FLEURS/LibriSpeech/MUCS do not [A: re-check at download]. MUSAN is distributed as one large archive (~11 GB [A]).
- 8 GB host: Docker VM + Node dev servers + benchmark compete; swap already in use [M]. Benchmarks run with dev servers stopped.
- In-memory task state lost on restart (resubmission); no mid-file checkpoint (≈ 20 min repeated at 4 h [E]). *Measured: restart recovery works (E2E scenario 6); a 4 h file takes ≈ 288 s, so a restart repeats at most ≈ 5 min.*
- Lossy-format timestamps depend on FFmpeg gapless/edit-list handling [A].
- ADR-0002/0023/0018 provisional; revisit if the prototype disproves them. librosa deferral deviates from the HLD list.

## 21. Dependencies to install later (after approval)

NumPy 2.x (BSD-3, Workstream 3); `onnxruntime` 1.26.x + Silero ONNX model (MIT; benchmark group, runtime only if
selected); `webrtcvad-wheels` 2.0.14 (MIT/BSD; benchmark only); FFmpeg already in the image, optional Homebrew on the
host; datasets §17. No paid service, model or dataset.

## 22. Consistency review (revision 4)

Revision 3 checks retained (one block size, one memory threshold, unchanged container limits, one thread configuration,
disk-only temp data, decision IDs defined once). Revision 4 additions checked: control-status labels used in §6 and §7
only; `timeline` column appears in §11.2, §12 and D-2B-05; timestamp criteria in §14 reference §11.3; D-2B-08 and
D-2B-17 marked decided/applied in §15 and §18 and nowhere else described as pending; no text claims development egress
is blocked; Landlock is [proposed] and conditional everywhere it appears. *(Revision-4 consistency note; Landlock is now [verified], see §6.2.)*
