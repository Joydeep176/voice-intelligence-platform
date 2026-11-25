# Project learning journal

A plain-English guide to what this platform is, how it works, what has been built and verified, where it stands, and
what comes next.

It is a reading aid, not a source of truth. When it disagrees with `docs/SRS.md`, `docs/architecture/` (HLD, LLD,
ADRs), `docs/PROJECT_STATUS.md` or `docs/development/PHASE2B_2C_RESUME_CHECKPOINT.md`, those documents win.

Written 2026-11-24, late evening IST. **Re-synchronised 2026-11-25, late evening,** with the Phase 2B/2C closure
(`PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`): B-1 closed by ADR-0041, real-provider E2E passed. Earlier sync, same day: the finished C3 benchmark queue, the idle-host
STT A/B, the idle real-service check and the revert of the whisper.cpp source build. The sources are the checkpoint's
2026-11-25 section and the STT speed README (`phase2c-provider-validation/stt-speed-2026-11-24/README.md`).

## How to read the status words

This journal keeps three levels apart and never promotes one to another.

| Word | Meaning here |
| --- | --- |
| **Reported** | A record or an earlier session says so. Not re-checked in the latest session. |
| **Verified** | Checked by a test run or a measurement whose evidence is saved in the repository, and the date is given. |
| **Formally accepted** | The user has accepted it, and it is recorded in an ADR or the HLD §10 register. Acceptance is the user's decision; nothing becomes accepted because tests passed. |

Decision statuses (Accepted, Accepted provisionally, Interim, Proposed, Open) are as defined in HLD §10.

---

## 1. Product vision and capabilities

### What the product is for

The AI Voice Intelligence Platform analyses recorded voice audio in **English, Hindi and Hinglish** (mixed
Hindi-English). It produces an **evidence-backed intelligence report**: what was said, by whom, in what context,
which claims can be checked, what outside evidence says about them, and how confident the platform is. It is
general-purpose: voice notes, interviews, meetings or long recordings of over two hours (SRS §1.2, FR-1.1).

### The ten workflow steps (SRS §3, HLD §3)

| # | Step | Who does it | Built so far? |
| --- | --- | --- | --- |
| 1 | Ingestion and validation | API plus an audio-service probe (deterministic) | **Yes** (Phase 1 upload; Phase 2B probe) |
| 2 | Preprocessing and segmentation | Audio service (deterministic, not an agent) | **Yes** (Phase 2B) |
| 3 | Audio quality and distortion analysis | A1 Audio Quality Agent | Measurements only (Phase 2B). The agent is not built |
| 4–5 | Transcription and diarization | A2 Transcription Agent | Foundation only (Phase 2C): fake providers verified; real providers implemented but **not yet passing** end to end |
| 6 | Context intelligence | A3 | Not started (agent phase not approved) |
| 7 | Deep internet research | A4 | Not started |
| 8 | Fact validation | A5 | Not started |
| 9 | Report generation | A6 | Not started |
| 10 | Quality assurance | A7 (independent, read-only) | Not started |

### Capabilities that define the product (from the SRS and ADRs)

- **Upload long audio safely:** resumable multipart uploads, a consent attestation, and the original file stored
  unmodified (FR-1.x).
- **Honest provenance:** every report statement is labelled `recorded` (said in the audio), `external` (from research
  evidence) or `inferred` (AI interpretation).
- **Immutable machine output:** raw provider output is never edited. Corrections create new versions (ADR-0007).
- **Two kinds of "how sure are we":** *audio diagnostics* (is the signal noisy or clipped?) are kept separate from
  *transcription uncertainty* (is the model unsure what was said?).
- **Snapshot evidence:** fact verdicts cite a saved copy of the source, never a fragment that could change later
  (ADR-0017).
- **Workspace isolation:** a workspace is the unit of data ownership; one workspace never sees another's data
  (ADR-0003).
- **Bounded cost and resources:** bounded workers, memory gates and deadlines (ADR-0010, ADR-0039), and **zero
  additional spending** (ADR-0034): free, local and self-hosted components only.

---

## 2. Current architecture and audio-processing pipeline

### The pieces (CLAUDE.md, HLD §5, LLD)

```
Browser (apps/web: React, Tailwind, shadcn/ui)
   │  REST /api/v1
   ▼
API (apps/api: NestJS) ──── Postgres (Drizzle; pgvector enabled)
   │  enqueues jobs                ▲
   ▼                               │
Redis + BullMQ ◄──── Orchestrator (apps/orchestrator: NestJS workers; owns the job lifecycle)
                                   │  internal HTTP + bearer token (ADR-0035)
                                   ▼
                     Audio service (services/audio: Python, FastAPI provisional)
                       ├─ FFmpeg children in a sandbox (probe, preprocess)
                       └─ inference child in a sandbox (transcribe: whisper.cpp + Silero VAD;
                          diarize: sherpa-onnx)
                     Storage: recordings/ (read-only)  derived/ (write)  /models (read-only volume)
```

- **Node owns jobs.** BullMQ queues, retries, progress and the run lifecycle live in Node (ADR-0002, OD-04a Accepted).
- **Python is a separate service** behind an internal API. It never touches Postgres, Redis or BullMQ. It reads and
  writes object storage and returns metadata (`.claude/rules/python-audio.md`).
- **LangGraph** is the planned orchestrator for the seven agents. It is *Accepted provisionally* (OD-04b) and not yet
  exercised: a Phase 2C coordinator stands in until the agent phase.
- **Contracts** are zod schemas in `packages/contracts`, mirrored as Python models, so the two sides cannot drift
  silently.

### The audio pipeline as it exists today

1. **Upload.** The file arrives in parts. The original is stored unmodified with its SHA-256. A run record is created
   with status `created` (ADR-0025).
2. **Probe.** The audio service runs `ffprobe` in a sandbox to check the format, duration, channels and sample rate
   against the limits: 4 h, 2 GiB, ≤ 8 channels, ≤ 192 kHz (FR-1.3, ADR-0039).
3. **Preprocess.** FFmpeg decodes to a **canonical 16 kHz mono 16-bit WAV**. The service builds a **timeline** that
   maps canonical time back to original time, computes **objective measurements** (levels, clipping, silence, DC
   offset and similar), and segments the audio. Outputs are versioned by a hash of the full configuration and tool
   versions, so reprocessing never overwrites what another run uses (ADR-0015). Preprocessing VAD stays `none` by
   decision.
4. **Transcribe** (Phase 2C). The orchestrator splits the canonical audio into **30 s windows with 1 s overlap**. For
   each window, the audio service:
   - finds speech spans with **Silero VAD** (ADR-0038);
   - decides each span's language (`en` or `hi`; Urdu probability counts towards Hindi);
   - decodes the span with **whisper.cpp small, q5_1**.

   Spans exist because Whisper decodes one language per pass. Forcing one language on a mixed window either garbled
   a segment or *translated* the Hindi into English.
5. **Diarize** (Phase 2C). **sherpa-onnx** with pyannote segmentation-3.0 and CAM++ speaker embeddings decides who
   spoke when. Files up to 10 min are processed whole. Longer files go through 10 min windows with 30 s overlap,
   matching speakers across windows, so memory stays bounded (ADR-0016).
6. **Persist.** Raw provider output is stored write-once and immutably. Transcript versions are built from it, and
   the UI shows segments, speakers and the timeline.

### The sandbox (why the audio service is the most hardened part)

Uploaded media is **untrusted input**. Every FFmpeg or inference child runs through `SandboxRunner`:

- **Landlock:** a Linux kernel feature limiting which files a process may read and blocking network connections.
- **rlimits:** CPU time, no file writes, at most 64 open files, no core dumps.
- A clean environment (never the service token) and the input passed as an already-open file descriptor.
- Its own process group, killed on cancellation or deadline.

The service checks at startup that the sandbox is actually enforced. Since 2026-11-24 it also checks that the
inference child can read the models (`inference_models_unreadable` otherwise).

---

## 3. Completed and verified engineering work

| Phase | Status | Basis |
| --- | --- | --- |
| **Phase 1, platform foundation** | **Formally accepted** (PROJECT_STATUS; committed `79050cc`) | Acceptance checks passed 2026-11-20 (`PHASE1_FOUNDATION.md` §8) |
| **Phase 2A, frontend redesign M0–M8** | **Formally accepted** 2026-11-21 (committed `b407c38`) | Consolidated validation passed after remediation (`docs/design/phase2a-validation/`) |
| **Phase 2B, audio processing foundation** | **Implemented and verified** (2026-11-21/22). Acceptance: see §4, the records disagree | `PHASE2B_COMPLETION.md` |
| **Phase 2C, transcription and diarization foundation** | **Fake-provider pipeline verified**. Real providers implemented; **real end-to-end run not yet passed** | `PHASE2C_COMPLETION_REPORT.md`, checkpoint |

### Phase 2B in brief (verified 2026-11-21/22, reported in `PHASE2B_COMPLETION.md`)

- Sandboxed audio service: contract v2, bearer auth, Landlock-confined FFmpeg.
- Probe and validation of new uploads; explicit-request preprocessing.
- Migration `0002`, applied to the dev DB after a backup.
- Orchestrator step-jobs with bounded retries and deadlines; processing API; processing card in the UI.
- 2026-11-22 closure pass: build, lint and typecheck passed; the full web Playwright suite gave 95 passed, 0 failed,
  11 skipped.

### Phase 2C, and the 2026-11-24 closure sessions

**Reported** (Phase 2C report, 2026-11-24 afternoon):
- Fake-provider pipeline: unit and integration tests and a genuine browser end-to-end run passed.
- Migration `0004` applied after a verified backup.
- Both UI defects fixed and unit-tested: the stale recording header and the "later phase" timeline copy.

**Verified in session 3** (2026-11-24 evening; evidence in the checkpoint and `phase2c-provider-validation/`):

| What | Result |
| --- | --- |
| GIL blocking fixed: inference runs in a **sandboxed child process** through the same `SandboxRunner` (an "inference profile"), not a weaker one-off | Host audio suite 736 passed; container suite **961 passed, 0 failed** (12 pre-existing skips) |
| The audio service stays responsive during real inference | About 15 min of real inference: **1719 and 1708 liveness probes, 0 failures**, p99 13 ms and 26 ms, max 0.56 s; peak memory about 483 MiB of 768 MiB, no OOM kill |
| Defect found and fixed: Landlock cannot confine reads from Docker Desktop host bind mounts | Models now come from a read-only named volume (`audio-models`), still checksum-verified. A new startup self-test reports `inference_models_unreadable` instead of silently failing every task |
| Real diarization through the service | Succeeded on the 90 s synthetic clip: RTF about 1.6, 5 speakers found (the reference has 4 in the full 5-min file) |
| Integration suites | **DB 57/57, API 67/67, orchestrator 60/60**; `pnpm lint` and `pnpm typecheck` pass |
| Orchestrator bug fixed | A mistyped provider key now raises `UnknownProviderError` instead of a misleading "token required" error |
| Dev tooling | The deny rule `Read(./storage/**)` was added (user-approved); model-routing hook tests **123/123** |
| whisper.cpp built from source for the CPU (user-approved on 2026-11-24) | Built and tested (`DOTPROD = 1`, `FP16_VA = 1`), then **reverted on 2026-11-25**: see below |

**Verified 2026-11-25** (evidence: checkpoint 2026-11-25 section; `stt-speed-2026-11-24/ab-idle-2026-11-25.log` and
`real-check-idle-2026-11-25.json`):

| What | Result |
| --- | --- |
| C3 benchmark queue finished (20:29 on 24 Nov → 09:15 on 25 Nov) | Result files present for WeSpeaker accuracy (passes a and b), WeSpeaker resources (5 min file RTF 5.38; 60 min file RTF 5.94, DER 0.171, 12 speakers hypothesised, peak 401 MiB), WeSpeaker 512 MB feasibility (no OOM kill, peak 256 MiB) and cpp-medium pass b (40 clips). **Not yet aggregated** (`run.py report` not run) |
| Idle-host A/B, 30 s window at 1 CPU, 3 interleaved runs each | Standard wheel **349.7 s** mean (347.4–350.8 s); source build **347.1 s** mean (339.1–353.6 s). Same languages in every run. Other containers at ≤ 1.4 % CPU |
| Real service check on an idle host (source-build image, 768 MB, 1 CPU) | Landlock **enforced** and scoped (ABI 8); preprocess succeeded; **all 3 transcribe windows `TIMEOUT` at about 240.6 s**; diarization **succeeded** (RTF 1.67, 5 speakers, 14 turns); 1720 liveness probes, **0 failures**, p99 18 ms; peak memory **546 MiB of 768 MiB**, no OOM kill |

**Decision (user, 2026-11-25):** revert the source build, because the A/B showed no meaningful improvement. The
Dockerfile now installs the **standard pywhispercpp 1.5.1 wheel** from `uv.lock` again. The test that asserted the
source build's CPU flags was removed with it. Model, VAD, language detection, deadline and limits are unchanged.
**The image has not been rebuilt or redeployed**: the running audio service still contains the source build.

---

## 4. Current Phase 2B/2C status and unresolved blockers

### Status in one line

**Phase 2B and 2C are ACCEPTED.** The user formally accepted them on 2026-11-26, after end-to-end validation with the
real providers (`PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md` §0). Acceptance does not close every item: the accuracy
thresholds stay TBD, three validation activities are not tested, and the known limitations remain (below).

### How B-1 (STT too slow) was closed

The audio service had 768 MB and **1 CPU**. Every real 30 s transcription window missed its 240 s deadline.

1. **Cause, measured:**
   - Whisper's encoder is about 99 % of the time.
   - Each speech span needs two full encoder passes: one to detect the language, one to decode.
   - macOS **Low Power Mode** had also been slowing everything by about 1.7×. The user turned it off.
2. **Code-only fix, rejected:** decoding with an encoder context sized to the span was fast on one span. On all 240
   test clips, though, it was not materially faster, and accuracy fell sharply (Hindi WER 49 % → 90 %). This was
   the E7 accuracy gate. It was reverted and never deployed.
3. **CPU scaling:** close to linear. The 5-span window took 278 s at 1 CPU, 143 s at 2, 73 s at 4 (E8).
4. **User decision: 2 CPUs and 2 threads (ADR-0041,** confirmed Accepted 2026-11-26). The real check then passed: windows took
   114 / 116 / 148 s.

### What was verified on 2026-11-25

- **Browser end to end with the real providers:** whisper.cpp and sherpa-onnx, `fake: false`.
  - Upload → validation → preprocessing → transcription → diarization → persisted transcript.
  - English and Hindi (Devanagari) segments, 4 speakers.
  - Reload-safe; another workspace gets 404.
- **Failure paths through the browser:** corrupt media, too many channels, duplicate submission, cancel then retry
  (stored windows reused), an audio-service outage with recovery, and a deadline timeout on fragmented speech.
  All behaved safely and showed a readable cause.
- **60 min diarization in the production container:** anonymous peak 524 MiB of 768, no OOM (bounded memory).
- **Fixed along the way:**
  - duplicate inference tasks after an outage, through content-derived idempotency keys;
  - three UI truthfulness bugs;
  - a benchmark report crash.
- **Final suites green:** unit, integration, audio host and container, Compose hardening, build, lint, typecheck.

### Acceptance records (corrected 2026-11-26)

ADR-0040 used to say the user accepted Phase 2B and 2C on 2026-11-24. At the user's direction it was corrected on
2026-11-26: the user approved the closure work and the decision items, and has **not** given final acceptance.
The user then formally accepted both phases on 2026-11-26; all records now say **ACCEPTED**.

### Open items for the user

| # | Item | State |
| --- | --- | --- |
| U-1 | Accuracy thresholds (SRS NFR-3 WER/CER, NFR-4 DER) | **Undecided.** A deferral is proposed in ADR-0042, awaiting the user's decision; measured, not passed. The numbers are reported (production path: English WER 10.5 %, Hindi 48.7 % / CER 23.6 %, Hinglish 84 %; DER 6–21 % by speaker count). The baseline is preserved in ADR-0042 |
| U-2 | Dense speech against the 240 s deadline (**temporarily accepted as a known limitation, 2026-11-26**; config unchanged) | About 30 s per speech span at 2 CPUs. The synthetic conversations peak at 7 spans per window (fits). A constructed 14-span window times out safely after 3 attempts. The options (more CPU, a longer deadline, shorter windows, merging spans) are all user decisions |
| U-3 | ADR-0041 final status | **Confirmed Accepted (2026-11-26)** |
| U-4 | Outstanding validation: `test:phase2b:e2e` re-run, Graphify refresh, transcription over 2 h | Not tested; none deferred. Run them, or the user explicitly defers them |
| O-1 | Diarization over-clusters (12 found for 4 on 60 min) | Known limitation; speakers can be renamed |
| O-2 | Hinglish written in Devanagari; spans labelled `en`/`hi`, never `mixed` | Known. `mixed` labelling is the Transcription Agent's job (agent phase) |
| O-3 | Words repeated across the 1 s window overlap | Known (segment-level stitching) |
| O-4 | Production readiness | **Not production-ready** (auth, deployment target OD-48, OD-23c, retention, deletion) |

---

## 5. Technical concepts in plain English

| Concept | Plain English |
| --- | --- |
| **STT** (speech-to-text) | Turning speech into written words. Here, Whisper via whisper.cpp |
| **Diarization** | Working out *who spoke when*: "speaker A from 0:03 to 0:11", without knowing their names |
| **VAD** (voice activity detection) | Finding the parts of audio that contain speech. Silero VAD is a small neural model for it |
| **Speech span** | One continuous stretch of speech found by VAD. Each span is transcribed on its own, with its own language |
| **Window** | A 30 s slice of audio processed as one unit, overlapping its neighbour by 1 s so no word is cut in half |
| **Canonical audio** | One standard format (16 kHz, mono, 16-bit WAV) that every later step reads, whatever was uploaded |
| **Timeline mapping** | A table that converts times in the canonical audio back to times in the original file |
| **WER / CER** | Word or character error rate: the share of words or characters the transcript got wrong. Lower is better |
| **DER** | Diarization error rate: the share of time attributed to the wrong speaker, missed or invented. Lower is better |
| **RTF** (real-time factor) | Processing time ÷ audio length. RTF 0.5 means a 60 s file takes 30 s; RTF 8 means 60 s takes 8 minutes |
| **Quantisation (q5_1)** | Storing model weights with fewer bits so the model is smaller and faster, at a small accuracy cost |
| **DOTPROD / FP16** | CPU instructions that do many small multiplications at once. Software must be compiled to use them. Here, compiling them in made no measurable difference to whisper.cpp's speed (A/B, 2026-11-25), so the standard wheel was kept |
| **A/B test (interleaved)** | Run version A and version B alternately, several times, under the same conditions. Alternating stops a change in host load from favouring one side; repetition shows run-to-run spread |
| **Wheel vs source build** | A wheel is a ready-made Python package downloaded pre-compiled. A source build compiles it locally, which can enable CPU-specific options at the cost of a compiler in the image and longer builds |
| **GIL** | Python's global lock: only one thread runs Python at a time. The native speech engines held it, so the web server froze. Hence the child process |
| **Sandbox / Landlock / rlimits** | Fences around a process: which files it may read, no network, limits on CPU, files and memory. Used because uploaded media is untrusted |
| **Bind mount vs named volume** | A bind mount shows a host folder inside a container. A named volume is storage Docker manages. On a Mac, Landlock cannot fence bind-mounted files, so the models moved to a volume |
| **Idempotency key** | A label that makes retrying a request safe: sending it twice does the work once |
| **Provenance** | Where a statement came from: `recorded`, `external` or `inferred` |
| **Immutable raw output plus versions** | Never overwrite what the model said. Corrections and derivations are new versions that point back to it |
| **Fake provider** | A stand-in STT or diarization engine that returns predictable output, so the pipeline can be tested without real models. Kept for tests (OD-02a / OD-03a) |
| **Bimodal timing** | Measurements cluster around two very different values, here about 8 s and about 45 s per span (24 Nov). The 24 Nov reading was that it followed host load. **The idle-host runs of 25 Nov were all slow** (about 350 s per window), so load does not explain B-1, and the fast runs remain unexplained. Lesson: one timing, or timings taken at different moments, cannot be trusted |
| **Efficiency cores** | The M1 has fast and slow CPU cores. If macOS runs Docker's virtual CPU on a slow core, the same work takes longer. This was offered as an explanation on 24 Nov; it was **never tested**, and the idle-host result makes host scheduling an unlikely explanation for B-1 on its own |

---

## 6. Important architectural decisions and their rationale

| Decision | Status | Why |
| --- | --- | --- |
| **Seven product agents**; decoding, normalisation, VAD and segmentation are *not* agents (ADR-0001, ADR-0019) | Accepted | Deterministic signal processing should be repeatable and testable, not an AI judgement. Clear boundaries keep agents focused |
| **Node owns jobs, Python is a separate audio service** (ADR-0002) | Accepted (integration); LangGraph provisional | One owner of queues, retries and progress. Python's audio and ML ecosystem stays isolated behind a contract |
| **Workspace isolation** (ADR-0003) | Accepted | Ownership and privacy boundaries are enforced everywhere, including 404s across workspaces |
| **Synthetic or consented data only** in development (ADR-0004) | Accepted | No real recordings or transcripts in code, logs, tests or docs |
| **Immutable raw output and versioned corrections** (ADR-0007) | Accepted | Auditability: you can always show what the machine produced and who changed what |
| **Poor audio does not stop processing** (ADR-0008) | Accepted | Report the limitation rather than refuse; diagnostics travel with the result |
| **Bounded workers, deadlines and memory gates** (ADR-0010, ADR-0039) | Accepted | Predictable cost and stability on small hardware (an M1 with 8 GB) |
| **Fakes first, then benchmark before choosing real providers** (ADR-0012) | Accepted | Build and test the pipeline without vendor lock-in; choose providers on evidence |
| **Diarization within bounded memory** (ADR-0016) | Accepted (principle) | Recordings can exceed 2 h; memory must not grow with length |
| **Zero additional spending** (ADR-0034) | Accepted | Only free, local and self-hosted components. This conflicts with the earlier Claude-API and AWS assumptions, which are flagged as OD-47 / OD-48 (Open) |
| **Audio-service networking and bearer auth** (ADR-0035) | Accepted (dev topology) | Loopback-only port plus a token. Production service auth is OD-23c (Open) |
| **Silero VAD inside transcription windows** (ADR-0038) | Accepted | Per-span language decoding fixed code-switching errors (forced language mis-decoded or translated Hindi) |
| **768 MB audio service, inference deadline 120 s + 4 × audio** (ADR-0039); **2 CPUs and 2 threads** (ADR-0041, amending 1 CPU) | ADR-0039 and ADR-0041 Accepted | Measured memory need (about 489 MiB anonymous at peak; 574 MiB `memory.peak` in the 2-CPU real check). At 1 CPU the time budget was missed (B-1); at 2 CPUs every real window fits (at most 148 s against 240 s) |
| **Phase 2B/2C closure decisions** (ADR-0040) | Recorded as Accepted (see the §4 reconciliation note) | Records the D-2B decisions and the OD-18 / OD-23a / OD-39 resolutions |
| **STT: whisper.cpp small q5_1 + Silero spans** (OD-02b) | Register says Accepted; **ADR-0036 not yet written** | Best accuracy that fits 8 GB and the 768 MB service; free (MIT); no network at runtime. Medium models were OOM-killed at 512 MB |
| **Diarization: sherpa-onnx + pyannote seg-3.0 + CAM++** (OD-03b) | Register says Accepted; **ADR-0037 not yet written** | Free and ungated ONNX models (no PyTorch, no gated downloads); bounded-memory windowing measured on a 60-min file (DER 0.077) |
| **Models from a read-only named volume** (2026-11-24, this closure) | Implemented, verified; to be recorded in ADR-0036/0037 | Keeps the Landlock confinement real on Docker Desktop |
| **Standard pywhispercpp 1.5.1 wheel; source build reverted** (user decision 2026-11-25) | Dockerfile reverted; recorded in the checkpoint, not yet in an ADR; image not rebuilt | An idle-host A/B showed no meaningful speed difference (349.7 s vs 347.1 s), so the compiler toolchain, sdist build and rpath patching were not worth their complexity |

---

## 7. Future roadmap, including machine-sound intelligence

Nothing in this section is approved. Each item needs the user's approval, and new scope also needs requirements and
ADRs (`.claude/rules/documentation.md`).

### Already defined in the requirements, awaiting approval to start

1. **Agent phase**, steps 3 and 6–10: Audio Quality, Context Intelligence, Research, Fact Validation, Reporting and
   QA agents on LangGraph (FR-3 to FR-10). Prerequisites:
   - OD-47, the production LLM runtime within ADR-0034;
   - OD-05, a research provider that is free and self-hostable;
   - OD-30, the verdict taxonomy (*Proposed*).
2. **Transcript corrections and derived representations** (SRS §3.11, ADR-0007, ADR-0020), such as transliteration of
   Devanagari Hinglish, which would address O-2.
3. **Production readiness:**
   - authentication and roles (OD-08b, OD-27);
   - a deployment target within ADR-0034 (OD-48);
   - production service auth (OD-23c);
   - retention, deletion, rate limiting and security headers.

### Machine-sound intelligence (a user-raised direction; not in the SRS, not approved)

**Idea:** extend the platform from *voice* intelligence to the *non-speech sounds* in a recording, for example
recognising machine or equipment sounds and changes in them.

**What the current documents say:**
- The SRS scopes the product to voice in English, Hindi and Hinglish (§1.2, A-2).
- ADR-0001 fixes exactly seven agents.
- The audio service deliberately makes **no quality judgements** (FR-2.5).
- No requirement, OD or ADR covers machine sounds today.

**How it could fit without breaking current decisions** (considerations to discuss, not a design):
- **Deterministic first.** Objective non-speech measurements, such as spectral features, event timing and the
  regions VAD marks as non-speech, belong in the audio service like today's measurements: no judgements, versioned
  by configuration.
- **Interpretation as agent work.** Explaining what a sound *means* is an AI judgement. It would either extend the
  Audio Quality Agent's remit or need a new agent. A new agent would require amending ADR-0001 (seven agents).
- **Separate from transcription.** Keep sound-event output separate from transcript uncertainty, as diagnostics are
  today.
- **Constraints that still apply:** zero spending (free, local models only), bounded memory and CPU on the 8 GB M1,
  synthetic or consented data only, provenance on every report assertion.

**First steps if approved:**
1. Write the requirement (new FR IDs) and the scope boundary.
2. Open an OD for the approach and model candidates.
3. Run a small benchmark on synthetic or consented machine-sound data.
4. Record the decision with `record-architecture-decision`.

---

## 8. Immediate next steps and acceptance criteria

**Done (verified 2026-11-25):**
- B-1 closed with ADR-0041.
- The real-provider browser E2E and failure paths passed.
- The C3 report was regenerated.
- ADR-0036, ADR-0037 and ADR-0041 were written.
- The requirement-to-evidence matrix and the final acceptance report were written.
- The final suites are green.

| # | Step | Passes when |
| --- | --- | --- |
| 1 | **Done 2026-11-26:** formal acceptance of Phase 2B and 2C; ADR-0041 confirmed; dense-speech limitation temporarily accepted | Recorded in all authoritative records |
| 2 | Phase 3A **planning** (no implementation): define scope, requirements, architecture, acceptance criteria and plan | User approval of each before implementation |
| 2a | Still open: NFR-3 / NFR-4 thresholds (ADR-0042 Proposed); not tested: phase2b e2e re-run, Graphify, over 2 h | User decision / run when scheduled |
| 3 | Optional robustness follow-ups (not blocking) | Cancel abandoned audio tasks (`DELETE /v1/tasks/{id}`); treat a deterministic `TIMEOUT` / `RESOURCE_EXHAUSTED` as non-retryable; fail-closed readiness instead of a crash |

**Standing constraints for all steps:**
- no paid services;
- no commits or pushes without a request;
- preserve existing data and the completed UI work;
- keep the fake providers for tests;
- do not start Phase 3 or the agent phase.
