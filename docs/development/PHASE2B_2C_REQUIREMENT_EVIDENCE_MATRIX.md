# Phase 2B / 2C: requirement-to-evidence matrix

Date: 2026-11-25; updated 2026-11-26. Companion to `PHASE2B_2C_FINAL_ACCEPTANCE_REPORT.md`.

**Phase 2B and 2C were formally accepted by the user on 2026-11-26.** Acceptance does not change any row's status:
rows marked Awaiting decision, Not tested, Blocked or N/A stay as shown. The dense-speech limitation (NFR-2 row) is
temporarily accepted as a limitation, not a pass.

**How to read it:**
- Requirement IDs are from `docs/SRS.md`.
- Statuses:
  - **Passed:** code exists and a passing test or run exists.
  - **Failed:** a test or run failed. There are **none**.
  - **Deferred:** the user has explicitly deferred it. There are **none** so far.
  - **Awaiting decision:** the acceptance criterion itself is undecided, so the result can be neither passed nor failed.
  - **Not tested:** outstanding; no evidence yet, and not deferred by the user.
  - **Blocked:** depends on an Open decision outside 2B/2C.
  - **N/A:** outside the 2B/2C scope, with the reason given.
- A row is Passed only when code and a passing test or run exist. Documentation alone does not count.

**Abbreviations:**
- **E2E** = `docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25/` (real providers, browser).
- **2B-REC** = `PHASE2B_COMPLETION.md` (Phase 2B validation, 2026-11-21/22).
- **INT** = integration suites (DB / API / orchestrator).
- **CTR** = audio container suite.
- **CH** = Compose hardening.

| Req | Phase | Implementation | ADR / decision | Automated tests | Integration / E2E evidence | Benchmark | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FR-1.1 voice notes to > 2 h | 2A/2B | `apps/api/src/recordings`, multipart upload | ADR-0039 (4 h max) | API unit + INT | 2B-REC: 4 h FLAC processed (`phase2b-resources/`); E2E 33 s and 90 s | — | Passed |
| FR-1.2 multipart, resumable | 1/2A | `recordings.service.ts` | API §2 | API INT (upload sessions) | Browser uploads (E2E) | — | Passed |
| FR-1.3 validation with a clear reason; limits | 2B | `services/audio` probe, `orchestrator/processing` | ADR-0039 | CTR (probe, limits) | E2E `fail-invalid` (`CORRUPT_MEDIA`), `fail-unsupported` (`RESOURCE_LIMIT_EXCEEDED`) with UI reasons | — | Passed |
| FR-1.4 original stored unmodified | 2B | storage keys; canonical derivative | ADR-0007 | CTR; 2B E2E scenario 2/9 | 2B-REC | — | Passed |
| FR-1.5 / SEC-1 consent attestation | 2A | upload UI and API | SEC-1 | web + API tests | Browser: Upload disabled until the consent box is ticked (E2E flow) | — | Passed |
| FR-2.1 canonical decode, original unmodified | 2B | `preprocess` task | ADR-0002 | CTR | E2E (preprocessing succeeded) | — | Passed |
| FR-2.2 Silero VAD spans inside 30 s / 1 s windows | 2B/2C | `transcribe.py`, `runs/windowing.ts` | ADR-0038, ADR-0039 | audio unit (`test_inference_unit.py`), orchestrator windowing | E2E: 4 windows for 90 s; E10 span counts | E10 | Passed |
| FR-2.3 timestamps in ms of the original | 2B/2C | timeline mapping; window offsets | 2B timestamps | CTR timestamps; stitch tests | E2E: segments monotonic, max end 89,794 ≤ 90,000 | `phase2b-timestamps/` | Passed |
| FR-2.4 preprocessing versioned by configuration | 2B | `audio_preprocessings`, config hash | D-2B | DB INT | 2B-REC | — | Passed |
| FR-2.5 deterministic, no quality judgements | 2B | preprocess | ADR-0019 | CTR | 2B-REC | — | Passed |
| FR-3.1 / 3.2 / 3.4 Audio Quality Agent diagnostics | Agent phase | — | ADR-0001 | — | — | — | N/A: agent phase (not approved) |
| FR-3.3 diagnostics separate from transcription uncertainty | 2C (partly) | separate tables; separate UI sections | FR-9.3 | `App.test.tsx` (separate sections) | E2E UI: "Audio quality" and "Transcription uncertainty" shown separately | — | Passed (2C side); diagnostics themselves are agent phase |
| FR-3.5 quality analysis and transcription independent | Agent phase | — | ADR-0021 | — | — | — | N/A: no quality analysis yet |
| FR-4.1 transcription with timestamps | 2C | `providers/stt/whisper-cpp.ts`, `transcribe.py` | ADR-0036 | orchestrator `self-hosted.spec.ts`; audio unit | E2E: 17 / 7 timestamped segments | E7 | Passed (segment-level; word-level not requested) |
| FR-4.2a language per segment (`en` / `hi`) | 2C | per-span detection | ADR-0036 | audio unit (`choose_language`) | E2E: `en` + `hi` on the 90 s clip | E7 LID: en 77/80, hi 80/80 | Passed |
| FR-4.2b `mixed` label and code-switch spans | Agent phase | — | ADR-0001 (Transcription Agent) | — | Hinglish → `hi` only (E2E) | Hinglish WER 84 % | N/A: Transcription Agent, agent phase |
| FR-4.3 script and code-switching preserved as produced | 2C | raw stored verbatim; text not rewritten | ADR-0007 | `self-hosted.spec.ts` (raw keeps provider text) | E2E: Devanagari rendered (2 / 7 segments) | — | Passed |
| FR-4.4 raw provider output immutable | 2C | `stt_raw_outputs`, `diarization_raw_outputs`, triggers | ADR-0007 | DB INT (UPDATE blocked); orchestrator raw-store tests | E2E `transcript/raw`: `whisper-cpp`, sha256, `fake: false` | — | Passed |
| FR-4.5 corrections and derivations as versions | Later | `POST .../versions` not implemented | ADR-0007 | — | — | — | N/A: designed only, outside the 2C scope (PHASE2C_DEVELOPMENT) |
| FR-4.6 consistent speaker IDs; bounded memory | 2C | `diarize.py` windowed matching | ADR-0037, ADR-0016 | audio unit (windows, matching) | E2E: 4 speakers; 60 min run succeeded | Windowed DER 7.7 % (60 min) | Passed up to 60 min; **> 2 h Not tested** |
| FR-4.7 transcription uncertainty model | 2C | `transcription_uncertainties` | ADR-0007 | DB INT; orchestrator align | E2E: `overlapping_speech` 2, `speaker_uncertain` 1 | — | Passed for the model and 2 kinds; low-confidence, inaudible and language kinds not generated (limitation) |
| FR-4.8 providers selected by configuration | 2C | `providers/registry.ts` | ADR-0012, 0036, 0037 | registry tests (unknown key) | E2E: real providers via env; INT with fakes | — | Passed |
| FR-11.1 per-stage status and progress | 2B/2C | run snapshot; progress propagation | ADR-0018 | web `transcript-section.test.tsx`; API INT | E2E: 25 / 50 / 75 / 100 % in the UI = API; UI terminal state without a reload | — | Passed |
| FR-11.2 safe cancellation | 2C | cancel route; cooperative stop | API §3 | API + orchestrator INT (cancel mid-run) | E2E `fail-cancel-retry`: cancelling → cancelled, no transcript, windows kept | — | Passed |
| FR-11.3 retry from the checkpoint, bounded | 2C | retry route; raw reuse | ADR-0039 (3 retries) | INT (retry reuses windows; limit 409) | E2E: retry resumed at 50 %, reused 2 windows; outage retry completed | — | Passed |
| FR-11.4 view transcript, speakers, uncertainty | 2C | transcript UI | API §5 | web tests | E2E (reload persists) | — | Passed for the 2C scope; diagnostics, claims and report are agent phase |
| FR-12.1 / 12.4 corrections and re-runs | Later | not implemented | ADR-0020 | — | — | — | N/A: outside the 2C scope |
| FR-12.2 speaker display names (machine IDs fixed) | 2C | `PATCH .../speakers` | ADR-0007 | API INT; mocked Playwright rename | Not exercised in the real-provider E2E | — | Passed (INT + browser on a mocked network) |
| FR-12.3 renames audited | 2C | `run-audit.ts` | SEC-8 | API INT (rename audit) | — | — | Passed |
| NFR-1 > 2 h end to end | 2B/2C | windows; windowed diarization | ADR-0039 | — | 2B: 4 h processing; 2C: 60 min diarization only | — | **Not tested** for 2C transcription > 2 h (about 8–10 h of run time at the measured RTF) |
| NFR-2 bounds (deadlines, retries) | 2B/2C | task deadline; provider and run timeouts | ADR-0039, ADR-0041 | INT (deadline, provider timeout) | Real check: TIMEOUT at 240.8 s (1 CPU); at 2 CPUs all windows ≤ 148 s; fragmented 14-span window → `AUDIO_TIMEOUT` after 3 attempts, shown in the UI. **Known limitation (temporarily accepted 2026-11-26):** windows with more than about 7–8 spans exceed 240 s | E8 | Passed |
| NFR-3 transcription accuracy | 2C | — | ADR-0012, ADR-0042 | — | — | E7 / C3 numbers (§6 of the report; baseline in ADR-0042) | **Awaiting decision:** no threshold; deferral proposed (ADR-0042). Measured, not passed |
| NFR-4 diarization accuracy | 2C | — | ADR-0012, ADR-0042 | — | — | DER (§6; baseline in ADR-0042) | **Awaiting decision:** no threshold; deferral proposed (ADR-0042). Measured, not passed |
| NFR-5 no completed stage lost on a worker crash | 2C | raw-first persistence; sweeper | ADR-0010 | orchestrator INT (sweeper recoveries, adopt stored raw) | E2E: cancel/retry and outage reused stored windows | — | Passed |
| NFR-6 provider swap needs no domain change | 2C | adapter interfaces | ADR-0012 | registry + adapter tests | Fake ↔ real by env only | — | Passed |
| NFR-7 bounded memory for any length | 2B/2C | windowed diarization (`read_ms` per window) | ADR-0016, ADR-0037 | audio unit | 60 min in 768 MB: anonymous peak 524 MiB, no OOM (`diarize-60min-bounded-memory-2026-11-25/`) | — | Passed (60 min measured; longer covered by design) |
| NFR-8 observability without content leakage | 2B/2C | logs with IDs and codes | OD-15 (tooling Open) | security review | evidence grep: no transcript text | — | Passed for content hygiene; tooling decision OD-15 open |
| SEC-2 workspace isolation | 2A–2C | workspace-scoped routes | ADR-0003 | API + DB INT | E2E: other-workspace run / recording → 404 | — | Passed |
| SEC-3 authenticated access | Production | development principal only | OD-08b (Open) | — | — | — | Blocked: OD-08b / OD-27 open (outside 2B/2C) |
| SEC-4 encryption | Production | — | OD-48 | — | — | — | N/A: development stack; production target open |
| SEC-5 retention | Production | — | OD-09b (Open) | — | — | — | Blocked: OD-09b |
| SEC-6 deletion of derived data | 2C (partly) | run / recording cascades | — | DB INT (cascades) | — | — | Not tested for storage objects (no deletion endpoint) |
| SEC-7 external data sharing | 2C | self-hosted; no outbound calls | ADR-0034, ADR-0035 | CH (network) | — | — | Passed (no outbound data flows) |
| SEC-8 auditability | 2B/2C | run requested / cancel / retry / rename audited | — | API INT | — | — | Passed for 2C actions; Phase 2B processing requests not audited (2B-REC §11) |
| SEC-9 secrets and content hygiene | all | content-free errors; token never passed to children | — | security review; tests | evidence grep | — | Passed |
| SEC-10 untrusted media isolated and limited | 2B/2C | Landlock, rlimits, fd-only input, sandboxed inference | ADR-0035, 0036 | CTR (960), CH (9) | Real checks: Landlock enforced | — | Passed |
| OPS-1 / OPS-5 concurrency limits | 2B/2C | queue concurrency; one service task at a time | ADR-0010, 0039 | config tests | E2E duplicate (one run) | — | Passed |
| OPS-2 timeouts | 2B/2C | task / provider / run deadlines | ADR-0039 | INT | Real TIMEOUT | — | Passed |
| OPS-3 bounded retries with backoff, retryable only | 2B/2C | BullMQ attempts 3; retryable classes | ADR-0039 | INT (attempts exhausted) | E2E outage (bounded; then failed) | — | Passed (see limitation 7: deterministic TIMEOUT is retried) |
| OPS-4 stalled jobs recovered | 2C | sweeper | ADR-0010 | orchestrator INT (3 sweeper recoveries) | dev orchestrator reloaded mid-run; the run continued (E2E fragmented) | — | Passed |
| OPS-6 / OPS-7 cost ceilings, loop caps | Agent phase | — | OD-28 | — | — | — | N/A: no paid usage or agent loops in 2B/2C |
| C-3 / C-6 adapters; synthetic data only | all | — | ADR-0012, ADR-0004 | — | All inputs synthetic (C3 corpus) | — | Passed |

**Summary:**

| Status | Rows |
| --- | --- |
| Failed | none |
| Deferred (user decision) | none |
| Awaiting decision (criterion undecided) | NFR-3, NFR-4: deferral proposed in ADR-0042 |
| Not tested (outstanding) | NFR-1 and FR-4.6 for recordings over 2 h; SEC-6 storage-object deletion |
| Blocked (Open decisions outside 2B/2C) | SEC-3 (OD-08b / OD-27), SEC-5 (OD-09b) |
| N/A (outside 2B/2C, reason given) | FR-3.1 / 3.2 / 3.4 / 3.5, FR-4.2b, FR-4.5, FR-12.1 / 12.4, SEC-4, OPS-6 / OPS-7 |
| Passed | all other rows |

**Outstanding validation activities (not requirements).** Status: **Not tested; none deferred.** They stay
outstanding until they are run or the user explicitly defers them:
- `pnpm test:phase2b:e2e` re-run;
- Graphify refresh;
- transcription of a recording over 2 h.
