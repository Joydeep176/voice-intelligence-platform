# Phase 2B · audio processing foundation — technical plan (DRAFT, revision 3)

**Status: DRAFT for the user's approval. Revision 3 (2026-11-21) is a consistency and risk-review pass. Nothing here is
approved; no code, dependency, model, dataset, migration, ADR or approved document was changed.** Revisions 1–2 are
superseded by this text.

Evidence labels: **[M]** measured on this machine (method stated) · **[R]** requirement (SRS, accepted ADR, project rule)
· **[E]** estimate, to be confirmed by benchmark · **[A]** assumption, to be verified during implementation ·
**[C]** computed from stated numbers. Decision IDs **D-2B-01 … D-2B-20** are defined once, in §15.

Constraints [R]: ADR-0034 (zero spending); hardware **Apple M1, 8 GB unified memory, 512 GB SSD** (user, 2026-11-21);
scope `docs/development/PHASE2B_SCOPE.md`.

---

## 1. Current state (verified in source; HEAD `f8686a3` plus uncommitted Phase 2A work)

| Area | State |
| --- | --- |
| Audio service | FastAPI skeleton: health probes and `POST /v1/handshake`; deps fastapi, pydantic, uvicorn. No FFmpeg use, storage access or task API |
| Audio container | `python:3.12-slim-trixie` + Debian `ffmpeg` (version unverified; image not built locally [M]), non-root uid 10001, read-only rootfs, `/tmp` tmpfs, cgroup limit **512 MB memory, 1.0 CPU**, Compose `--profile audio`, port published as `127.0.0.1:8001:8001` |
| Networking | Compose uses its default network only [M]. API reaches Python via `AUDIO_SERVICE_URL` (`.env.example`: `http://127.0.0.1:8001`) [M]. Orchestrator has no audio URL |
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

## 6. FFmpeg and untrusted-media hardening (D-2B-09)

Avoiding a shell is necessary but not sufficient. `-protocol_whitelist file,pipe` still allows `file`, and several
demuxers can open *other* local files (HLS/DASH playlists, `concat`, image sequences, MP4/MOV external data references),
which enables local file disclosure from a crafted upload [A: well-known FFmpeg risk class]. Design:

| Control | Specification |
| --- | --- |
| Input without a path | Python opens the original read-only and passes it to the child as an inherited file descriptor: `-i fd:3` with `-protocol_whitelist fd` (FFmpeg `fd` protocol, seekable for regular files [A: verify in the container's FFmpeg version, Workstream 1]). Fallback if unsupported: `pipe:0` streaming for non-MP4 formats; MP4 handled only after the fd check passes. The `file` protocol is never whitelisted |
| Explicit demuxer | `-f <demuxer>` chosen from the allow-list using the existing magic-byte sniff, never from the extension; plus `-format_whitelist` (wav, mp3, mov/mp4/m4a, flac, ogg, matroska/webm) |
| Codecs | `-codec_whitelist` for supported audio decoders only (PCM family, mp3, aac, alac, flac, vorbis, opus) |
| MP4/MOV references | `-enable_drefs 0`, `-use_absolute_path 0` set explicitly |
| Probe limits | `-probesize` and `-analyzeduration` capped; ffprobe JSON output size capped; reject > 8 channels or > 192 kHz (D-2B-18) |
| Output | Raw PCM to stdout pipes only; no FFmpeg-written files except the canonical WAV via Python |
| Filesystem isolation | Child runs inside the container: only `/storage/recordings` (read-only) and `/storage/derived` are mounted; cwd = the task temp directory; read-only rootfs |
| Network | Children have no network protocols (whitelist above). Container egress: see §7 |
| Environment | Child started with a minimal environment (`PATH`, `LC_ALL=C` only): no `AUDIO_SERVICE_TOKEN`, no inherited variables; `close_fds=True` except the input descriptor; stdin closed unless used for data; `-nostdin` otherwise |
| Secrets | Token only in the Python process; never in child environment, logs or storage |
| Limits | Wall-clock timeout per child; `RLIMIT_CPU` and `RLIMIT_FSIZE` set before exec; container cgroup caps memory; the whole process group is killed on timeout or cancel |
| Logging | Raw FFmpeg stderr (may contain metadata) is never logged; only exit status and a mapped error code |
| Malicious-media tests | Renamed HLS playlist, concat list, MP4 with an external data reference pointing at a canary file, image-sequence pattern, truncated and zero-length files, wrong magic, huge declared sizes/durations, 255-channel and 768 kHz headers, oversized ID3 tags, seeded mutation fuzzing of valid files. Pass = no canary read, no network attempt, bounded time and memory, mapped error code |

## 7. Networking and service discovery (D-2B-08)

| Setting | Development (API and orchestrator on the host) | Later all-in-Compose / production |
| --- | --- | --- |
| Python bind | Container: `0.0.0.0:8001` **inside the container** (required for publishing); host `uv run`: `127.0.0.1:8001` | `0.0.0.0:8001` inside the container |
| Port publishing | `127.0.0.1:8001:8001` only (existing) — not reachable from the LAN | **No published port** |
| Discovery | `AUDIO_SERVICE_URL=http://127.0.0.1:8001` for API **and** orchestrator (new orchestrator config) | `http://audio-service:8001` via Compose DNS on an `internal: true` network |
| Egress | Default bridge (egress technically possible; mitigated by FFmpeg protocol restrictions and no network use in code) | `internal: true` network: no external egress [A: internal networks do not support published ports, hence dev/prod differ] |
| Authentication (OD-23b) | Bearer `AUDIO_SERVICE_TOKEN` (≥ 32 chars, required, no default, never logged, constant-time compare) on all routes except liveness | Same token, or mTLS decided with OD-48 |

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

## 11. Timestamps (original timeline)

Definition: **t = 0 is the first sample of FFmpeg's decoded presentation timeline** of the selected audio stream, after
FFmpeg applies container edit lists and encoder-delay trimming. All timestamps are integer ms on that timeline.

| Effect | Handling |
| --- | --- |
| Resampling | Output sample index *n* at 16 kHz maps to `n / 16` ms exactly; FFmpeg's resampler compensates its filter delay [A: verified by tone-burst tests] |
| Channel conversion | Downmix is per-sample; no time shift |
| MP3 encoder delay/padding | FFmpeg applies LAME/Xing gapless information when present; files without it keep the decoder delay (≈ tens of ms) [A]; recorded as a warning |
| AAC priming / MP4 edit lists | Edit lists honoured (default) [A] |
| Variable bit rate | Sequential decoding (no seeking), so VBR cannot shift timestamps; the **decoded sample count** is the authoritative duration (header duration kept separately in `media_probe`, may differ for VBR without a TOC) |
| Non-zero stream start | Start time recorded in `media_probe`; output aligned so t = 0 is the first presented sample (`aresample` with `first_pts=0` [A]) |
| Gaps and partial decoding | `aresample=async` fills timestamp gaps with silence and trims overlaps so sample index keeps tracking presentation time [A: parameters set by tests]; skipped packets and gaps recorded as warnings; streams without usable timestamps get `TIMELINE_UNCERTAIN` |
| Browser player alignment | The app's player may differ slightly for lossy formats; not a 2B guarantee [A] |

Accuracy is a **benchmark measurement**, not a universal guarantee: tone bursts at known positions in every supported
container/codec (WAV, FLAC, MP3 CBR, MP3 VBR with and without Xing, M4A/AAC, Ogg Vorbis/Opus, WebM/Opus) with and
without leading offsets and injected gaps. Thresholds in §14.

## 12. Database migration inventory (D-2B-05) — one additive migration `0002_audio_processing` (not created)

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

## 13. VAD comparison and benchmark (D-2B-10)

| | Silero VAD (ONNX) | WebRTC VAD | Signal baseline |
| --- | --- | --- | --- |
| Method | Small stateful neural model, 32 ms frames at 16 kHz [A] | GMM classifier, 10/20/30 ms, aggressiveness 0–3 | Energy + spectral flatness + adaptive noise floor + hangover (NumPy) |
| Licence | MIT | MIT wrapper + BSD WebRTC | project code |
| Runtime | `onnxruntime` + vendored model (pinned SHA-256); **not** the PyTorch-based pip package | `webrtcvad-wheels` 2.0.14 | NumPy |
| ARM64 | macOS arm64 (macOS ≥ 14) and Linux aarch64 wheels | Linux aarch64 wheel; no macOS arm64 wheel found (host source build) | any |
| Memory / CPU | 30–60 MB [E]; vendor claim ≈ 30× real time on one thread [A] | < 5 MB, very low [E] | negligible [E] |
| Multilingual / noise | multilingual training, noise-robust per vendor [A]; Hindi–English unverified | language-independent; weak in non-stationary noise [A] | language-independent; weak in noise [A] |
| Maintenance | active | fork of an original last released 2017 | ours |

Excluded: PyTorch models (memory), TEN VAD (licence conditions).

**Method:** seeded mixtures from licensed speech (English, Hindi, Hindi–English) with 0.2–5 s gaps and noise at clean /
20 / 10 / 5 / 0 dB SNR, 16 kHz; dev/test split; labels from utterance spans and from energy-refined clean speech; tuning
on dev only; identical post-processing; frame-level (10 ms) FPR, FNR, F1; onset/offset error (median, p95);
post-segmentation speech coverage and non-speech inclusion; per language and SNR; RTF (median of 3) and `memory.peak`
in the container; 60/120 min files for drift; two runs for determinism. The user selects after results.

## 14. Acceptance criteria

**Mandatory (pass/fail)**

| Area | Criterion |
| --- | --- |
| Originals | SHA-256 and inode of every original unchanged across all tests, including failures and cancellations |
| Canonical audio | Mono, 16 kHz, s16; duration equals the decoded sample count |
| Determinism | Same input + config + tool versions → identical canonical SHA-256, measurements and segments |
| Measurements | RMS/peak within 0.1 dB and exact clipping counts on analytic synthetic signals |
| Timestamps, sample-exact formats | WAV/FLAC tone-burst onsets within 1 ms |
| Memory | Container `memory.peak` ≤ 384 MB on the 4 h benchmark; growth ≤ 10 % across 5 consecutive jobs |
| Cancellation | Cancelled status reached, FFmpeg process group gone and temp directory removed within 10 s |
| Recovery | After a service restart mid-task, resubmission completes within the retry bound with identical outputs |
| Hardening | All malicious-media tests pass (§6) |
| VAD process | Benchmark executed and reported per language and SNR before selection |
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
| D-2B-05 | A | Migration inventory §12 (deviations: `workspace_id` on segments/measurements, composite FKs, lifecycle columns, nullable segment `storage_uri`, `source`, `media_probe`) | Project database rule; workspace isolation | D-2B-01 | Yes |
| D-2B-06 | A | Internal contract v2 and browser endpoints §16 | Framework-independent contract (ADR-0002) | D-2B-01 | Yes |
| D-2B-07 | A | Progress via database snapshot polling §10; SSE deferred (OD-16) | One mechanism | D-2B-06 | Yes |
| D-2B-08 | A | Networking and bearer-token auth §7 (OD-23b) | Loopback-only dev; internal network later | D-2B-03 | Yes |
| D-2B-09 | A | FFmpeg sandbox §6 (fd input, demuxer/codec allow-lists, env sanitisation, limits, tests) | Untrusted media (SEC-10) | D-2B-03 | Yes |
| D-2B-10 | A | VAD selection process §13 (OD-29); selection itself after results | Benchmark before choice | D-2B-14 | Yes (process now, selection later) |
| D-2B-11 | A | Dependencies: NumPy; onnxruntime + Silero model only if selected; `webrtcvad-wheels` benchmark-only; librosa deferred | §9; ADR-0034 | D-2B-10 | Yes |
| D-2B-12 | A | Canonical audio mono 16 kHz s16 WAV; no loudness or dynamics processing by default | Lossless, simple random access, no speech degradation | — | Yes |
| D-2B-13 | A | Waveform peaks during the canonical pass, served by time range (OD-39) | No extra decode | D-2B-06 | Yes |
| D-2B-14 | A | Datasets §17 (OD-18), downloaded only after approval | Licensed, permitted use | — | Yes |
| D-2B-15 | A | Trigger: automatic after upload for new recordings; explicit start for the existing 23 | No silent backfill | D-2B-06 | Yes |
| D-2B-16 | A | Minimal frontend: real processing status and metadata on recording detail | Honest progress in UI | D-2B-07 | Yes |
| D-2B-17 | A | ADR-0034 hardware correction §18 | Factual accuracy | — | Yes |
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

## 18. Hardware correction (D-2B-17) — proposed, not applied

| File | Current | Proposed |
| --- | --- | --- |
| `adr/0034-…` Context (l. 13–14) | "…an Apple M2 with 16 GB unified memory." | "…an Apple M1 with 8 GB unified memory and a 512 GB SSD (corrected 2026-11-21; first recorded as an Apple M2 with 16 GB)." |
| same, Decision (l. 30) | "the Apple M2 16 GB machine" | "the Apple M1 (8 GB unified memory, 512 GB SSD)" |
| same, Consequences (l. 47) | "Local inference on 16 GB unified memory limits…" | "Local inference on 8 GB unified memory strictly limits…" |
| `HLD.md` OD-46 row | "(Apple M2, 16 GB)" | "(Apple M1, 8 GB unified memory, 512 GB SSD)" |
| `.claude/skills/add-provider-adapter/SKILL.md` l. 12 | "Apple M2 16 GB" | "Apple M1 8 GB" |
| `docs/development/PHASE2B_SCOPE.md` l. 23, 45 | "Apple M2"; "Apple M2, 16 GB, 512 GB SSD" | "Apple M1"; "Apple M1, 8 GB, 512 GB SSD" |

## 19. Implementation sequence (one Sonnet developer at a time)

| # | Workstream | Agent (model, tags) | Decisions | Depends on |
| --- | --- | --- | --- | --- |
| 0 | New measurement ADR; ADR-0034 correction | main session (opus), `record-architecture-decision` | D-2B-02, -17 | approval |
| 1 | Contracts v2; task executor; capabilities; bearer auth; storage backend; container mounts and networking; FFmpeg `fd`/version verification | backend-engineer (sonnet, `[backend] [opus-review-follows]`) | -04, -06, -08, -09 | 0 |
| 2 | Migration `0002_audio_processing`, repositories, DATABASE_DESIGN | backend-engineer (sonnet, `[backend] [opus-review-follows]`) | -05 | 1 |
| 3 | Sandboxed probe and streamed decode; NumPy added | backend-engineer (sonnet, `[backend] [opus-review-follows]`) | -09, -11, -18 | 1 |
| 4 | Measurements (passes A/B), canonical WAV, peaks | backend-engineer (sonnet, `[backend]`) | -12, -13 | 3 |
| 5 | VAD harness, corpus manifest, mixtures → benchmark in the container → **user selects** → adapter | backend-engineer (sonnet, `[backend]`); main session verifies | -10, -14 | 3 |
| 6 | Segmentation | backend-engineer (sonnet, `[backend]`) | -19 | 5 |
| 7 | Coordinator, `audio-task` step-job, hashing, persistence, progress, retries, cancel; API endpoints; upload trigger | backend-engineer (sonnet, `[backend] [opus-review-follows]`) | -01, -07, -15, -20 | 2, 4, 6 |
| 8 | Recording detail shows real processing status | frontend-engineer (sonnet, `[frontend]`) | -16 | 7 |
| — | **User reviews the implementation** | — | — | 1–8 |
| 9 | Consolidated tests, malicious-media suite, M1 benchmarks | test-engineer (sonnet, `[tests] [opus-review-follows]`) | — | review |
| 10 | Architecture review; security + data-integrity review | architecture-reviewer (opus, `[architecture]`); security-reviewer (opus, `[security]`) | — | 9 |
| 11 | Docs and acceptance report | main session (opus) + documentation-agent (sonnet, `[docs-technical]`) | — | 10 |

## 20. Risks

- Host memory pressure [M: swap in use]; benchmarks need a controlled machine state.
- FFmpeg `fd` protocol behaviour in the container's version is unverified [A]; fallback limits MP4 handling.
- Silero accuracy on Hindi–English code-switching unverified [A].
- WebRTC VAD needs a source build on the macOS host; benchmark in the container.
- Bind-mount ownership between uid 10001 and the macOS user unverified [A].
- Dev Compose network allows egress (internal networks cannot publish ports) [A]; mitigated by FFmpeg restrictions.
- In-memory task state lost on restart (resubmission); no mid-file checkpoint (≈ 20 min repeated at 4 h [E]).
- Lossy-format timestamps depend on FFmpeg gapless/edit-list handling [A].
- ADR-0002/0023/0018 provisional; revisit if the prototype disproves them. librosa deferral deviates from the HLD list.

## 21. Dependencies to install later (after approval)

NumPy 2.x (BSD-3, Workstream 3); `onnxruntime` 1.26.x + Silero ONNX model (MIT; benchmark group, runtime only if
selected); `webrtcvad-wheels` 2.0.14 (MIT/BSD; benchmark only); FFmpeg already in the image, optional Homebrew on the
host; datasets §17. No paid service, model or dataset.

## 22. Consistency review (revision 3)

Checked across the whole document: one block size (10 s; the 30 s figure appears only as a labelled preliminary
measurement); one memory threshold (≤ 384 MB `memory.peak`, §4.2, §14, D-2B-20); one container limit (512 MB / 1.0 CPU,
unchanged); one thread configuration (1); Docker setting unchanged everywhere; temp data on disk only (§5, §6, §15);
decision IDs D-2B-01 … D-2B-20 each defined once (§15) and referenced consistently (§2, §19); migration totals match the
§12 tables; preliminary vs target-environment measurements separated (§4.1); mandatory criteria vs approval targets
separated (§14). Revision 1–2 decision numbering is retired.
