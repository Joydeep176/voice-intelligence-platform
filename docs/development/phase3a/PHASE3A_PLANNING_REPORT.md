# Phase 3A: Audio Quality Intelligence (A1): planning report

- **Status: PLAN FOR THE USER'S REVIEW (2026-11-26). Planning only.**
  - No application code, runtime configuration, dependency, resource limit or accepted 2B/2C behaviour was changed.
  - **Documentation written:** this folder; Proposed ADR-0043 to ADR-0047; new HLD §10 rows OD-49–OD-51, OD-53 and
    OD-54 (Proposed) and OD-52 (Open); the PROJECT_STATUS Phase 3A row.
  - Nothing was downloaded. Nothing is committed.
- **Companion documents** (this folder):

| Document | Deliverables |
| --- | --- |
| `A1_REQUIREMENTS_AND_SPEC.md` | 1. PRD, 2. functional specification, proposed acceptance criteria |
| `A1_DESIGN.md` | 3. high-level architecture, 4. low-level design, 5. data flow, 6. API and contracts, 7. database, 10. security and resources |
| `A1_ALGORITHMS_AND_EVALUATION.md` | 8. algorithm and ML evaluation, 9. testing and benchmarking |
| `MULTI_AGENT_ARCHITECTURE.md` | The complete A1–A7 architecture and the dependency-aware roadmap |
| ADR-0043, ADR-0044, ADR-0045 (`docs/architecture/adr/`, **Proposed**) | 11. decisions that need an ADR |
| This report | 12. roadmap and milestones, and the final report (sections 1–14) |

## 1. What I found in the existing implementation

- **A1 is already specified, but not built.**
  - SRS FR-3.1–3.5, AGENT_ARCHITECTURE (A1 boundaries, the `audioQuality` state key, A1 ∥ A2), DATABASE_DESIGN
    (`audio_diagnostics`, `audio_diagnostic_flags`) and API §4 (`GET /api/v1/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics`) all describe it.
  - None of it is implemented: no table, endpoint, stage or contract.
  - The web app has honest placeholders: the "Audio quality" card, the "Audio quality analysis" step, a `diagnostics`
    timeline track, and `--diag-*` tokens kept separate from uncertainty (ADR-0030).
- **Rich objective measurements already exist** (Phase 2B, `services/audio/.../domain/measurements.py`), stored
  immutably per preprocessing version in `audio_measurements`:
  - peak, RMS and crest factor;
  - clipping counts and runs;
  - DC offset and inter-channel correlation;
  - EBU R128 integrated loudness, LRA and true peak;
  - silence ratio and a noise-floor estimate;
  - a 100 ms RMS/peak `level-series.json`;
  - timeline gaps and decode errors;
  - probe metadata.
  - Each value is labelled measured, derived or estimate. `snr` is explicitly `unavailable: no_speech_split`.
  - The service is guarded against emitting judgements (the `FORBIDDEN_KEY` test).
- **Speech-aware measurement is missing.**
  - Preprocessing VAD is fixed at `none` (ADR-0038), so there are no speech segments and no SNR, speech ratio or
    speech-level figures.
  - Silero VAD exists only inside `transcribe`, and it returns spans only.
- **No product agent and no LangGraph exist.**
  - The run is one sequential `run-transcription` BullMQ job with `RUN_STAGES = [transcription, diarization]`.
  - OD-04b (LangGraph) and ADR-0021 (A1 ∥ A2) are provisional, pending validation that has never been possible.
- **librosa is not used**, despite the docs mentioning it. NumPy and FFmpeg do all the signal work.
- **The brief differs from accepted records in three places.** Each is now a *proposed amendment* awaiting your
  approval (revised 2026-11-26 after your architecture review). None of them is applied:
  1. **A1 output as read-only metadata for A2, A3, A6 and A7** (ADR-0046, OD-54). This amends FR-3.5, ADR-0019,
     ADR-0021, AGENT §1–§4 and TESTING §3.
     - It gives *availability*, with no execution dependency (A2 and A3 never wait for A1) and no behavioural coupling
       in 3A.
     - There is no automatic blocking or skipping (ADR-0008 unchanged). "Require intervention" means the user's
       informed choice before starting transcription.
  2. **Four overall classes** instead of the designed `good | degraded | poor` (ADR-0043, OD-49).
  3. **Phase 3C as a distinct intelligence path** (ADR-0047, OD-53), not folded into A1 or A3. This amends SRS C-4.

## 2. What can be reused

| Reuse as is | Where |
| --- | --- |
| Tier 0 measurements, level series, timeline, probe metadata | `audio_measurements`, `recordings.media_probe`, storage |
| Silero VAD (pinned, verified, sandboxed), and the ADR-0038 settings | `domain/transcribe.py`, `inference_child.py`, `/models` |
| Audio-service task framework: registry, idempotency, deadlines, sandbox, cancellation | `domain/tasks.py`, `runner.py`, `isolation.py` |
| BullMQ step-job pattern, sweepers, content-derived idempotency keys | `processing/preprocess.step.ts`, `audio-sweep`, `providers/audio-task.ts` |
| Stage records, run lifecycle, cancellation, duplicate-submission guard | `pipeline_stage_runs`, `runs/run.step.ts` |
| Workspace isolation guard, composite workspace FKs, immutability triggers | `WorkspaceAccessGuard`, migration 0002 |
| Synthetic corpora with ground truth: the Phase 2B VAD corpus (known SNR, speech labels, 7 noise types), C3 STT clips (E7 WER per clip), C3 diarization conversations, 2C failure-path clips | `services/audio/benchmarks/*`, `docs/development/phase2*` |
| UI placeholders, diagnostics tokens, polling hooks | `apps/web/src/...` |

## 3. What A1 should actually do

- **Turn objective measurements into an explainable, actionable assessment of fitness for processing:**
  - an overall class (four classes proposed, D-3A-04) with a categorical confidence;
  - suitability for transcription and for diarization, with reason codes;
  - timestamped flags (kind, severity, basis, measurement references);
  - fixed-template recommendations;
  - an explicit list of the conditions it *cannot* assess (distortion other than clipping, reverberation in v1).
- **Show it to the user before transcription starts**, with no automatic stop (D-3A-03).
- **Provide one stable, versioned, read-only summary contract** (`AudioQualitySummary`, `AudioQualityContext`) for
  A2, A3, A6 and A7 (ADR-0046, *Proposed*). Availability is not a dependency: only A6 waits for A1.
- **It does not:** transcribe, detect overlap or language, enhance audio, classify sound sources, or call an LLM.
  Details: `A1_REQUIREMENTS_AND_SPEC.md` §1.4 and §3.

## 4. Proposed architecture

**Measure in the service, persist in the orchestrator, judge in A1** (`A1_DESIGN.md` §1–§2).

- **Audio service:** a new deterministic `measure` task (Tier 1, speech-aware), with no judgements. Preprocessing is
  unchanged.
- **Orchestrator:**
  - an `audio-measure` step after preprocessing (preprocessing-scoped and cached);
  - the A1 node `agents/audio-quality/`, a pure rule engine with a diagnostics-only repository, run as its own job
    (`aq-<runId>`) with an `audio_quality` stage row;
  - BullMQ for the Phase 3A implementation. **The shared LangGraph graph remains the target orchestration for the
    whole platform (OD-04b, unchanged).** A1 is built with framework-independent node contracts (input, output,
    state slice) so that it joins that graph without redesign. There is no separate orchestration system for A1
    (D-3A-02).
- **API:** the designed diagnostics endpoint, and an additive processing-snapshot field.
- **Web:** the placeholders become live.
- **Complete A1–A7 view:** `MULTI_AGENT_ARCHITECTURE.md`.

## 5. Proposed algorithms and ML approach

- **Deterministic signal processing.** The only learned component is the existing Silero VAD, used as a speech/
  non-speech instrument.
- **SNR proxy:** the VAD-split energy method.
  - M0 evaluates it against the **known mixing SNR** of the synthetic Phase 2B corpus, which is the ground-truth
    reference.
  - WADA-SNR (deterministic, dependency-free) is evaluated against the same reference as a secondary baseline. It is
    never treated as ground truth.
- **Bandwidth:** spectral roll-off on speech frames.
- **Fragmentation:** span statistics, plus spans per 30 s window to predict the ADR-0041 deadline risk.
- **Rules:** ordered, versioned and configuration-driven. Thresholds are calibrated on synthetic degradations against
  the production STT error.
- **Learned quality models** (DNSMOS, NISQA, Squim, Brouhaha) were evaluated on paper. None is needed for v1, and each
  brings PyTorch or a new ONNX runtime, or has an unverified licence.
- Details: `A1_ALGORITHMS_AND_EVALUATION.md` §1–§4.

## 6. Workflow and integration design

```
upload → probe → preprocess (unchanged) → measure (new) → A1 on the run (status created) → UI shows assessment
                                                            user starts transcription → A2 (unchanged in 3A; never waits for A1)
future: A2 → A3 → A4 → A5 ─┐      (A2, A3 may read the A1 summary as optional read-only metadata, ADR-0046 Proposed)
        A1 summary ────────┴→ A6 (join) → A7      Phase 3C: distinct path after preprocessing (ADR-0047 Proposed)
```

- A1 failure never affects transcription.
- A measure failure degrades A1 to Tier 0 with `low` confidence.
- Re-runs reuse the measurements and re-classify with the current rule version.
- Details: `A1_DESIGN.md` §3 and `A1_REQUIREMENTS_AND_SPEC.md` §4–§5.

## 7. Data contracts

`A1_DESIGN.md` §4:

- `AudioQualitySummary` v1, the only shape other components read;
- `AudioDiagnosticFlag` and `AudioDiagnostics`;
- the `measure` task contract (`MeasurementRecord` schema v2, `speech-series.json`);
- the pipeline-state slice `audioQuality`.

Database (`A1_DESIGN.md` §5): one migration.

- **New:** `audio_measurement_sets`, plus the designed `audio_diagnostics` and `audio_diagnostic_flags` (immutable).
- **Modified:** `audio_measurements` (uniqueness and a set reference) and the `pipeline_stage_runs` node CHECK.

## 8. Resource and performance estimates

- **Tier 0 classification:** under 1 s and a few MB, in Node. No audio-service call.
- **Tier 1 measure task:** dominated by Silero VAD.
  - The Phase 2B evidence is RTF 0.017 at 1 CPU and 172 MiB peak. That is about 4 min for a 4 h recording at 1
    thread; 2 threads should be faster, but not 2× (to be measured).
  - Memory stays bounded and well inside 768 MB.
  - Time is far inside the media deadline.
  - It adds seconds (short clips) to minutes (4 h) of audio-service occupancy, against hours of transcription.
- **No limit, model, window or deadline changes.** All figures are estimates, and the 4 h figure is **not measured**. M0 gives
  indicative harness figures in the production image; M4 measures the implemented task, which is the only acceptance
  evidence (`A1_DESIGN.md` §6).

## 9. Evaluation strategy

- **Corpus:** a locally generated synthetic degradation corpus, built on the existing corpora (known SNR, gain, clip
  ratio, gaps, band limits, silence, fragmentation, multi-speaker, en/hi/Hinglish).
- **Metrics:**
  - per-flag precision and recall at clip and region level;
  - false-positive rate on clean clips;
  - SNR-proxy error;
  - determinism, monotonicity and gain invariance;
  - Spearman correlation with E7 WER;
  - "not assessable" handling;
  - RTF and memory.
- **Test layers:** unit (Pytest, Jest), contract (Vitest), DB / orchestrator / API integration, container, web, E2E,
  and a non-CI benchmark with saved evidence.
- **The main evidence gap is real speech.** OD-18 corpus downloads would need the user's approval (D-3A-13).

## 10. Proposed acceptance criteria

- `A1_REQUIREMENTS_AND_SPEC.md` §6 lists AC-1 to AC-14.
- **AC-5, AC-6, AC-8, AC-9 and AC-10 carry numeric targets (P, R, X, Y, Z) that I have deliberately left unset.** M0
  and M6 produce evidence-based proposals, and the user approves them (D-3A-10).
- The rest are binary: separation, determinism, monotonicity, isolation, deletion, UI states, regression and E2E.

## 11. Implementation milestones

Each milestone ends with the targeted tests, then the affected package suites, then a stop for review (the
development-first sequential workflow). No milestone changes resource limits or 2B/2C behaviour.

### M0: decisions and feasibility spike

- **Objective:** turn the estimates into evidence before any production code.
- **Scope (precise):**
  1. A benchmark **harness** in `services/audio/benchmarks/quality/`. It is not in `src`, and the runtime-image check
     stays green. It runs only offline, on existing local corpora, with nothing downloaded.
  2. **Estimator accuracy** on the Phase 2B VAD corpus (known mixing SNR, reference speech labels; en / hi / Hinglish;
     7 noise types at 20 / 10 / 5 / 0 dB):
     - SNR, following the methodology in `A1_ALGORITHMS_AND_EVALUATION.md` §6.1:
       - both the VAD-split estimate and WADA-SNR are evaluated against the known mixing SNR (the ground truth);
       - WADA-SNR is a secondary baseline only;
       - results are MAE and mean bias in dB, grouped by noise type, language and SNR level;
       - limitations are reported, not filled in;
     - speech ratio against the reference labels;
     - effective-bandwidth estimate on band-limited copies;
     - spans per 30 s window against the 2C dense and fragmented clips.
  3. **Block size** choice (500 against 1000 ms): region accuracy against series size.
  4. **Harness cost and determinism:**
     - RTF, `memory.peak` and anonymous peak of the harness inside the production image at `--cpus 2 --memory 768m`,
       using the image's pinned sherpa-onnx Silero and NumPy;
     - repeat-run determinism of Silero at 2 threads (AC-4).
  5. A saved evidence document, `docs/development/phase3a-quality-benchmark/`, with numbers only and synthetic data.
- **Fidelity: harness measurements are not task measurements.**
  - The harness runs the same algorithms with the same pinned libraries in the production image. It does **not** run
    the production `measure` task: there is no task API, sandboxed child, Landlock or rlimits, inherited descriptor,
    task deadline, idempotent publish or concurrent service process.
  - M0 figures are therefore *indicative*. They decide the design, but they are not acceptance evidence for AC-10.
  - **M4 must repeat** performance (RTF), memory (no growth on a generated 4 h file) and sandbox validation (Landlock
    enforced, deadline, cancellation) against the implemented task in the production container.
- **Not in M0:** application code, contracts, migration, model or dataset downloads, limit changes, or STT sweeps
  (those are M6).
- **Dependencies:** only D-3A-00 (your approval of the plan's direction and of this benchmark-only spike). M0 *produces*
  the evidence for D-3A-07 (SNR-based kinds, `fragmented_speech`) and D-3A-09 (Tier 1 design or fallback). Those are
  confirmed after M0, before M1.
- **Code:** benchmark only (not in `src`; the runtime-image check stays green).
- **Tests:** metric unit tests (the C3 `test_metrics.py` pattern).
- **Acceptance:** the evidence document is saved; the estimator is chosen with its error figures; the cost is measured.
- **Resources:** the existing image, locally.
- **Risks:** the SNR proxy is unreliable at 0–5 dB. **Fallback:** report SNR only as a band (high / medium / low), or
  drop the SNR-derived severity.
- **Done when:** the user has reviewed the evidence and confirmed the Tier 1 design (or the fallback).

### M1: contracts and migration

- **Objective:** the typed foundation.
- **Scope:**
  - zod schemas and Python mirrors (measure task, `AudioQualitySummary`, flags, diagnostics);
  - the framework-independent A1 node boundary (`A1NodeInput`, `A1NodeOutput`, the `audioQuality` state slice) and,
    if ADR-0046 is approved, `AudioQualityContext` and the `AudioQualityReader` port;
  - a separate `STAGE_NODES` enum; `RUN_STAGES` (the transcription scope) unchanged;
  - fixtures, including invalid ones;
  - migration `0005_audio_quality` (§7 tables, triggers, CHECKs);
  - the `audio_quality` stage.
- **Dependencies:** M0; D-3A-04, D-3A-05, D-3A-07, D-3A-09 decided.
- **Code:** `packages/contracts`, `packages/db`, `services/audio/.../contracts.py`.
- **Tests:**
  - contract tests;
  - DB integration: constraints, immutability, cascade deletion, workspace FKs;
  - the existing suites.
- **Acceptance:** the migration applies cleanly to the test DB (the repo has no down-migration convention; rollback SQL
  is documented, DATABASE_DESIGN pattern); no change to existing rows or hashes; the processing-snapshot reader is
  unchanged for existing data.
- **Risks:** changing the `audio_measurements` uniqueness. Mitigation: additive and backfill-free.
- **Done when:** the security review of the migration passes.

### M2: A1 vertical slice on Tier 0

- **Objective:** the end-to-end value using only existing measurements.
- **Scope:**
  - `agents/audio-quality/` rule engine (Tier 0 rules) with provisional config;
  - the A1 job and stage, triggered on a `created` run whose preprocessing has succeeded (D-3A-03);
  - re-assessment;
  - `GET /api/v1/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics` (API §4).
- **Dependencies:** M1; D-3A-02, D-3A-03, D-3A-06 decided.
- **Code:** orchestrator (agent module, queue, worker, sweeper hook, `finishCancelled`) and API (controller, service,
  repository read).
- **Tests:**
  - table-driven rule tests, monotonicity and determinism;
  - the separation import-graph test (A1 reads no transcription table; others read A1 only through the reader port);
  - transcription output identical with the A1 context present, absent or failed (AC-2);
  - job integration: failure isolation from `run-transcription`, cancellation;
  - SEC-2 404 and SEC-9 log capture.
- **Acceptance:** AC-1, AC-2 and AC-12 for Tier 0; the 2B/2C suites stay green (AC-3).
- **Resources:** negligible.
- **Risks:** run-status semantics (D-3A-06).
- **Done when:** a reviewed demo with synthetic clips via the API.

### M3: UI for the assessment

- **Objective:** users see the assessment.
- **Scope:**
  - the card (class, confidence, suitability, reasons, recommendations, not assessed);
  - the processing step;
  - a flag list;
  - honest pending, failed and provisional states.
- **Dependencies:** M2.
- **Code:** `apps/web`, under the `frontend-design` skill.
- **Tests:** Vitest state tests, a copy test (measured / estimated / assessed; never transcript language), axe.
- **Acceptance:** AC-13 except the timeline.
- **Risks:** users over-trusting provisional thresholds. Mitigation: a "provisional" label until M6 approval.
- **Done when:** a UI review.

### M4: the audio-service `measure` task (Tier 1)

- **Objective:** speech-aware objective measurements.
- **Scope:**
  - the task handler (streamed canonical read, Silero in the sandboxed child, block and summary features, series
    artefact);
  - capability reporting;
  - registration only when the VAD model verifies.
- **Dependencies:** M0, M1.
- **Code:** `services/audio/src/audio_service/domain/measure.py` (new), plus wiring in `contracts.py`, `tasks` and
  `app.py`.
- **Tests:**
  - unit tests on synthetic signals;
  - the judgement-key guard;
  - container tests: determinism, Landlock, memory on a generated 4 h file, deadline;
  - the Compose hardening suite unchanged.
- **Acceptance:** AC-4 (measurement) and AC-10, measured on the implemented task in the production container. This
  repeats M0's harness figures for the real task: RTF, memory with no growth on a generated 4 h file, Landlock
  enforced, deadline and cancellation. M0 figures do not count as AC-10 evidence.
- **Resources:** the measured RTF and memory, inside 768 MB / 2 CPUs.
- **Risks:** making the child's VAD path reusable without touching `transcribe`. Mitigation: a new entry point in the
  child, with `transcribe` code and tests unchanged.
- **Done when:** the security review of the task passes.

### M5: orchestrator measure step and Tier 1 rules

- **Objective:** wire Tier 1 in.
- **Scope:**
  - the `audio-measure` step job after preprocessing;
  - sweeper recovery;
  - backfill for existing preprocessings;
  - Tier 1 rules (SNR proxy, speech presence, low speech level, bandwidth, level consistency, dropouts at frame
    resolution, optional fragmentation);
  - fallback to Tier 0 on measure failure.
- **Dependencies:** M2, M4.
- **Tests:**
  - step-job integration with the scripted fake audio client (retry, cancel, reuse, failure → Tier 0);
  - rule tests;
  - E2E on synthetic clips.
- **Acceptance:** AC-1, AC-4 and AC-11 complete.
- **Risks:** audio-service queueing behind transcription. Mitigation: FIFO, measured in E2E.
- **Done when:** reviewed.

### M6: calibration and evaluation (USER GATE)

- **Objective:** evidence-based thresholds and acceptance values.
- **Scope:**
  - generate the degradation corpus;
  - run A1 on the dev and test splits;
  - transcribe the sweeps with the production STT path to anchor thresholds on WER/CER (E7 method);
  - produce the threshold proposal table and the metric report.
- **Dependencies:** M5.
- **Code:** benchmark only, plus the rule config values.
- **Tests:** the benchmark metric unit tests.
- **Acceptance:** the evidence is saved; **the user approves the thresholds and P, R, X, Y, Z (D-3A-08, D-3A-10)**;
  the rule version loses the "provisional" label only after that.
- **Resources:** several hours of local STT runs (as in C3 / E7).
- **Risks:**
  - synthetic-only calibration;
  - Hindi and Hinglish WER barely varying with SNR on this corpus.
- **Done when:** the user's decision is recorded through `record-architecture-decision`.

### M7: diagnostics timeline track, E2E and resources

- **Objective:** complete the UX and prove it on the real stack.
- **Scope:**
  - the timeline track (no new library while OD-35 is Open);
  - browser E2E per category (the AC-14 list);
  - a transcript-unchanged check against a reference run;
  - resource validation in the production container.
- **Dependencies:** M3, M5, M6.
- **Tests:** Playwright and the 2C real-stack scripts; axe.
- **Acceptance:** AC-13 and AC-14; AC-3 confirmed on the real stack.
- **Done when:** the evidence is saved under `docs/development/phase3a-*`.

### M8: closure

- **Objective:** acceptance package.
- **Scope:**
  - documentation updates (SRS where approved, AGENT §3–4, DATABASE, API, LLD, TESTING, PROJECT_STATUS);
  - security review and architecture-conformance review;
  - the full regression;
  - the requirement-to-evidence matrix;
  - the completion report.
- **Acceptance:** every AC has evidence or is visibly *not tested*.
- **Done when:** the user formally accepts Phase 3A.

## 12. Technical risks and unresolved questions

| Risk | Likelihood / impact | Mitigation |
| --- | --- | --- |
| The SNR proxy is inaccurate at low SNR or with non-stationary noise | Medium / medium | M0 measures it first against the known mixing SNR; WADA-SNR as a secondary baseline; banded output fallback; labelled *estimate* |
| Thresholds calibrated on synthetic TTS mislead on real speech | High / medium | Provisional label; real-speech recalibration (D-3A-13); conservative cut-points |
| Silero detects tones or music as speech, inflating speech presence | Low–medium / low | Fixtures; the VAD benchmark FPR is known (0.057) |
| Users read "poor" as "transcript wrong" | Medium / medium | Copy rules; diagnostics are visually separate from uncertainty (ADR-0030); suitability wording |
| Audio-service queue contention (measure ahead of transcription) | Low / low | Minutes at most for 4 h; FIFO; measured in E2E |
| Run-status semantics get confusing with an independent A1 stage | Medium / low | D-3A-06 decided up front; UI shows stages separately |
| Reverberation and non-clipping distortion are undetected | Certain / medium | Shown as *not assessed*, never as good; future model path documented |
| The A1 rule config drifts from the evidence | Low / medium | `ruleVersion` and the config snapshot are stored per diagnostics row; tests pin the config |
| Later phases are infeasible on 8 GB with a local LLM (A3–A7) | Medium–high / high (for 3B+) | Not a 3A risk. Flagged for OD-47 before 3B |

Unresolved questions are listed as decisions in §14.

## 13. Recommended implementation order

**M0 → M1 → M2 → M3 → M4 → M5 → M6 (user gate) → M7 → M8.**

- **The Tier 0 vertical slice (M2–M3) comes first.** It delivers user value from existing measurements, and it proves
  the contracts, persistence, separation and UI before any audio-service change.
- **Tier 1 (M4–M5) follows,** once M0 has shown that the estimators are worth having.
- **Calibration (M6) is a hard gate before the polished UX and acceptance.**

## 14. Decisions requiring the user's explicit approval

**When each decision is needed:**
- before M0: D-3A-00;
- before M1, after M0 evidence: D-3A-01 to D-3A-07 and D-3A-09;
- at M6: D-3A-08, D-3A-10;
- optional, at any time: D-3A-13;
- with plan approval, not a 3A prerequisite: D-3A-12 (reserving the Phase 3C path);
- deferred to later phases, not 3A prerequisites: D-3A-11 (3B), and the 3C design questions in ADR-0047.

| ID | Decision | Options | My recommendation | Record |
| --- | --- | --- | --- | --- |
| D-3A-00 | Authorise the M0 spike | The precise scope is §11 M0: a benchmark-only harness, existing local corpora, production image at 2 CPUs / 768 MB, indicative figures only; no runtime change, no download | Approve | — |
| D-3A-01 | A1 v1 method | (a) deterministic rules + Silero as instrument, no ML quality model, no LLM; (b) add a learned quality model; (c) LLM | (a) | OD-49, ADR-0043 (Proposed) |
| D-3A-02 | Orchestration in 3A | (a) introduce LangGraph now; (b) BullMQ for the 3A implementation inside the existing coordinator, with framework-independent A1 node contracts; the shared LangGraph graph stays the platform target (OD-04b unchanged), prototyped at 3B | (b) | OD-50, ADR-0044 (Proposed) |
| D-3A-03 | When A1 runs | (a) on the `created` run after measurements, **before** transcription is started. **Changes ADR-0025's consequences:** A1 can fail and be retried (A1-only) on a `created` run; cancelling a run stops a pending A1 stage and keeps completed diagnostics; the UI wording becomes "Audio assessed; transcription has not been started" (canonical lifecycle L1–L10 in `A1_DESIGN.md` §2.3.1). No stop, ADR-0008 kept; (b) only in a submitted run, concurrently with A2 (ADR-0021 as written) | (a) | OD-50, ADR-0044 (Proposed) |
| D-3A-04 | Overall classes | (a) `good / acceptable_with_warnings / poor / insufficient` (changes the designed enum, AGENT §3, DATABASE_DESIGN); (b) keep `good / degraded / poor` (`insufficient` folds into `poor` + `low_speech_presence`) | (a) | OD-49, ADR-0043 (Proposed) |
| D-3A-05 | A1 summary consumption, and "proceed / warn / require intervention" | (a) read-only metadata availability to A2, A3, A6, A7 through `AudioQualityReader`; no execution dependency for A2/A3; no behavioural coupling in 3A; no automatic blocking or skipping; guard rails keep diagnostics and uncertainty separate. **Amends FR-3.5, ADR-0019, ADR-0021, AGENT §1–§4, TESTING §3**; (b) full independence (the earlier proposal); (c) A2/A3 depend on and adapt to A1 (excluded by your review) | (a) | OD-54, ADR-0046 (Proposed) |
| D-3A-06 | Run status with an A1 stage | (a) run completion stays defined by the transcription scope; the A1 stage has its own status and retry; `RUN_STAGES` (the transcription scope) stays unchanged, and a separate stage-node enum gains `audio_quality`; diagnostics are pinned to the run's preprocessing version (re-assessed at submission if it differs); (b) a run completes only when A1 is also terminal | (a) for 3A; revisit at A6 (the join) | OD-50, ADR-0044 (Proposed) |
| D-3A-07 | Flag kinds and VAD settings | Add `low_speech_presence`, `narrowband`, `level_inconsistency`; optionally `fragmented_speech` (predicts the ADR-0041 deadline risk); `distortion` reserved; measure VAD uses the ADR-0038 settings | Add the three; `fragmented_speech` yes, with the ADR-0038 settings | OD-49, ADR-0043 (Proposed) |
| D-3A-08 | Threshold approach | Language-independent, conservative thresholds anchored on E7-style WER sweeps, provisional until approved | As stated | OD-52 (Open), M6 decision |
| D-3A-09 | Speech-aware measurement | (a) new `measure` task + `audio_measurement_sets`, preprocessing unchanged; (b) enable Silero in preprocessing (changes accepted 2B behaviour and hashes); (c) Tier 0 only. Also amends AGENT §4 ("A1 requests the `measure` task" → the preprocessing flow runs it, as DATABASE_DESIGN "Writers" already says) and confirms that per-block series meet FR-3.1 "per segment" while preprocessing VAD is `none` | (a) | OD-51, ADR-0045 (Proposed) |
| D-3A-10 | Numeric acceptance values P, R, X, Y, Z | Set after M0/M6 evidence | Decide at M6 | OD-52 (Open), M6 decision |
| D-3A-11 | Do A3–A7 run for every recording or on request? | Product decision for 3B | Deferred to 3B planning (not a 3A prerequisite) | — |
| D-3A-12 | Phase 3C placement | (a) a distinct intelligence path sharing platform infrastructure, A1–A7 unchanged, **SRS C-4 amended**; agent versus capability decided in 3C; (b) fold into A1 or A3 (rejected in your review) | (a); reserve now, design in 3C | OD-53, ADR-0047 (Proposed) |
| D-3A-13 | Real-speech evaluation in 3A | (a) synthetic only, real speech as a follow-up; (b) approve downloading licence-checked OD-18 sets (for example MUSAN noise, FLEURS en/hi) for evaluation | (a) for acceptance, (b) recommended as a separate approved step | — |

Unrelated but still open: **ADR-0042** (NFR-3 / NFR-4 accuracy thresholds) remains Proposed, awaiting your decision.

## Recommendation

**Yes, the Phase 3A design is technically feasible on the existing platform and the M1 / 8 GB hardware, within the
zero-additional-spend constraint.**

- It adds no dependency, model, download, paid service or resource change.
- Its only compute cost is one Silero pass and NumPy features per recording, inside the accepted audio-service limits.
- About half its value (Tier 0) comes from measurements that already exist.

**Assumptions and evidence gaps, stated honestly:**

1. **The cost figures are extrapolated** from the Phase 2B VAD benchmark (1 CPU, separate process). M0 measures a
   harness in the production image (indicative only). M4 measures the implemented task, and only M4's figures count
   as acceptance evidence.
2. **The SNR-proxy accuracy is unmeasured.** It is the main technical uncertainty, with a defined fallback.
3. **All calibration and evaluation would be on synthetic TTS speech with NumPy noise.** No result may be presented
   as real-world accuracy. Real-world validity is unproven until a real-speech corpus is approved and downloaded
   (D-3A-13).
4. **Reverberation and non-clipping distortion are not assessable in v1.** They are reported as such.
5. **Three proposed amendments to accepted records** (§1: ADR-0046, ADR-0043, ADR-0047) need your decision before
   implementation. None is applied until you approve it.
6. **The full multi-agent system beyond A1 depends on OD-47** (a local LLM runtime on 8 GB). That is the main
   feasibility risk for Phases 3B and later, not for 3A.

Implementation will not start until you review and approve this plan and the decisions above.
