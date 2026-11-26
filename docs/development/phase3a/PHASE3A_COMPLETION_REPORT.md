# Phase 3A: completion report (A1 Audio Quality Agent)

- **Date:** 2026-11-26.
- **Status: ACCEPTED. Phase 3A was formally accepted by the user (product owner) on 2026-11-26 and is closed.**
  Implementation (M0–M8) is complete. The known limitations in §4 stay open.
- **Nothing is committed, pushed or published.**
- **Phase 3B and the other agents have not been started.**
- **Evaluation coverage:** every benchmark accuracy figure below comes from locally generated synthetic data (macOS
  TTS speech, NumPy noise and degradations). **It is not evidence of real-world accuracy** (D-3A-13). A real-world
  smoke test (§2a) is additional evidence only.

## 1. What was delivered

| Area | Delivered |
| --- | --- |
| Decisions | ADR-0043 to ADR-0047 (accepted), ADR-0048 (thresholds and targets, OD-52); amendments to ADR-0019, 0021, 0025, 0044 and 0045; OD-55 opened (20 dB SNR bias follow-up) |
| Audio service | The `measure` task (Silero speech split, hybrid VAD-split SNR, LTAS bandwidth edge, 1 s block series, spans per 30 s window), sandboxed like `transcribe`; bounded contracts |
| Contracts and DB | A1 enums, schemas and summary; measure contracts mirrored TS ↔ Python. Migration `0005_audio_quality`: measurement sets, diagnostics, flags, immutability triggers, cascade deletion |
| Orchestrator | Deterministic rule engine `a1-rules-1.0`; the A1 job on `run-audio-quality` (runs on a `created` run before transcription; ensures the measurement set, otherwise falls back to Tier 0); trigger and stuck sweeps; attempt caps; set heartbeat |
| API | `GET /runs/{runId}/audio-diagnostics` and `POST …/retry` (workspace-scoped); cancellation of a `created` run |
| Web | Live audio-quality card, processing step and diagnostics timeline track. Visually and verbally separate from transcription uncertainty |

## 2. Final evidence (M8)

| Check | Result |
| --- | --- |
| Root build, lint, typecheck | Pass |
| Unit tests | contracts 185, db 5, web 279, api 211, orchestrator 142: all pass |
| Integration tests | db 68, api 74, orchestrator 73: all pass |
| Audio service tests and lint | 753 passed (236 skipped: container-only); ruff clean |
| `pnpm format:check` | Fails **only** on committed, unchanged dev-tooling files (`.agents/`, `.codex/`, `AGENTS.md`); this predates Phase 3A and was left untouched. Every Phase 3A file passes |
| Browser E2E with `a1-rules-1.0` (`e2e/e2e-results-v1.json`) | 11 of 11 categories assessed in 4–10 s, Tier 1 available; UI matches the API; axe has 0 violations on 3 pages; cross-workspace 404; no console errors |
| AC-3 transcript identity, A1 active | 17 of 17 segments identical; same speaker partition; transcription and diarization completed |
| 4 h performance test (`m8-task-check.json`) | RTF 0.0118 (target ≤ 0.05); anonymous peak 141.9 MiB; no OOM; 0 liveness failures; cancellation 4.0 s; deterministic |
| Synthetic detection (`m6-detection-v1.json`, 96 clips, real tasks) | Clean 12 of 12 `good`, no high flag; precision and recall 1.00 per language for clipping, low level, narrowband and dropout |
| Production STT relevance (`m6-stt.json`) | Spearman between class and WER: en 0.57, hi 0.53, Hinglish 0.73 |
| Dev audio service | Rebuilt twice from the final code, with no active work, DB data kept and limits unchanged (2 CPUs, 768 MiB, 64 pids, read-only); healthy; A1 verified end to end |

### 2a. Real-world recording smoke test (product owner, 2026-11-26)

- **What happened:** the product owner tested the running system with an actual real-world recording and confirmed it
  works.
  - A1 produced its quality assessment, diagnostics and recommendations.
  - Transcription ran as before.
  - A1 neither blocked nor skipped it.
- **Status:** recorded as the product owner's statement. No metrics or artefacts were captured, and the recording is
  not in the repository (ADR-0004).
- **What it shows:** the end-to-end path works on real audio. **It is not a real-world accuracy validation:** one
  recording, with no reference labels. AC-5, AC-6, AC-8 and AC-9 rest on the synthetic corpus.

Criterion by criterion: `PHASE3A_REQUIREMENT_EVIDENCE_MATRIX.md`. AC-1 to AC-7 and AC-9 to AC-14 are passed;
**AC-8 is partially met** (§4).

## 3. Independent reviews (M8)

| Review | Blocking | Resolved in M8 |
| --- | --- | --- |
| Security / data integrity | 0 | **Live-set heartbeat** (should-fix, correctness): the stuck sweep could fail a live measurement set queued behind a long transcription and silently discard its result. Fixed: a heartbeat on each poll, the completion result is checked (`measure_completion_discarded`), and an integration test was shown to fail without the fix. **Nits fixed:** symlink containment on the series write; bounds on the Tier 1 wire contract (series ≤ 200,000 blocks, ≤ 32 quantities, name pattern, finite values in Python), with tests. **Earlier blocking finding** (unbounded retries): verified fixed |
| Architecture conformance | 0 | **Created-run retry** (should-fix): a `created` run cancelled through the new path could be retried, against ADR-0025. Fixed: the API returns `409` and the UI hides Retry, with tests. **Stale docs fixed:** API_SPECIFICATION cancel, A1_DESIGN L2 and queues, LLD sweep row, spec §5 measure retry and L8. **Nits fixed:** the `provisional` comment, window grid from the transcription constant, a web test for the non-provisional label |

**Process note.** During M8 my source edits reloaded the dev orchestrators and API (`tsc --watch`) while the E2E ran.
Part B of the E2E crashed on a refused connection. I re-ran it against the same reference run, which completed
normally, and the harness now tolerates an API restart.

## 4. Known limitations and open items

1. **AC-8 is partially met (user decision 2026-11-26).**
   - SNR MAE meets Y = 2.0 dB at 10 dB (1.10) and 5 dB (0.79).
   - At **20 dB it is 3.05 dB** (bias −2.91 dB).
   - Y was not relaxed. The bias is a known limitation; the follow-up is **OD-55 (Open)**.
2. **Synthetic-only evaluation.** All accuracy evidence is synthetic, and the M6 STT sweep used one scene per
   language. Real-speech evaluation needs an approved corpus (D-3A-13).
3. **Lifecycle deviations: accepted (user decision 2026-11-26; ADR-0044 Amendment 2).** These are A1_DESIGN §9
   notes 4, 10 and 11:
   - the trigger sweep;
   - wider A1-only retry eligibility;
   - re-assessment after submission.

   The ADR amendment records their safeguards: pinned version, insert-only diagnostics, idempotent jobIds, the
   attempt cap, cancellation checks, and an unchanged run `retry_count`.
4. **Not implemented (documented):**
   - processing-cancel of an active measurement set (L8, Proposed);
   - the measurement backfill endpoint;
   - the `measurementSet` field on the processing snapshot.
5. **Recording deletion and derived-file cleanup (privacy and retention follow-up before production):** the API has
   no recording DELETE endpoint (this predates Phase 3A). DB rows cascade. The A1 series files sit under the
   recording's derived prefix for a future prefix delete.
8. **Formatting check:** `pnpm format:check` fails only on committed, unchanged dev-tooling files (`.agents/`,
   `.codex/`, `AGENTS.md`), outside Phase 3A. Not fixed here.
9. **Pre-existing flaky test:** `apps/api/src/audio-service/audio-service.client.spec.ts` is committed and unchanged
   by Phase 3A.
   - **Failure:** it failed once during the closure run, under load: a late `/v1/handshake` request reached the next
     test's stub handler.
   - **Re-run:** 3 of 3 passes in isolation, and the API suite passed 211 of 211.
   - **Status:** test isolation issue; not fixed here.
6. **Old assessments:** assessments made before ADR-0048 keep `a1-rules-0.1-provisional` and the provisional label;
   they are never rewritten.
7. **Synthetic dropouts:** digital-zero dropouts are flagged at low severity only (decision). On synthetic clips
   they cost +6.5 to +7.7 WER points.

## 5. Acceptance

**Phase 3A was accepted by the user on 2026-11-26.** The acceptance covers:
- A1 is implemented and integrated.
- The Phase 2B/2C transcription behaviour is intact: transcript identity and all suites pass.
- A1 does not block or skip transcription.
- A1 produces quality assessments, diagnostics and recommendations.
- The regression, integration, browser E2E and performance evidence of §2 stands.
- The real-world smoke test (§2a) is additional evidence.

The limitations in §4 are **not** resolved by the acceptance:
- AC-8 is partially met, and OD-55 is open;
- evaluation is primarily synthetic;
- the deletion and cleanup follow-up remains;
- the items in §4.4 are not implemented;
- the formatting-check failure in the tooling files remains.

Phase 3B and Phase 3C are **not** started or approved.

## 6. Graphify refresh and architectural review (2026-11-26)

**Command.** `graphify update .`
- Graphify 0.9.113, code-only AST extraction with no LLM backend (`.claude/rules/dev-tooling.md`).
- Output in `graphify-out/` (gitignored): `graph.json`, `graph.html`, `GRAPH_REPORT.md`, `manifest.json`.
- The previous graph (commit `b407c380`) was backed up by the tool to `graphify-out/2026-11-26/`.

**Result**
- 613 files; 5,577 nodes; 16,372 edges; 217 communities.
- Built at commit `b3c90f55`, over the working tree.
- **No import cycles detected.**
- 6 SQL files were not parsed: the optional SQL grammar is not installed, and was not installed (no new dependency).
- 29 files, mostly specs, gave no symbols.

**A1 dependencies.** These come from the graph's file-level edges and were verified against the source.

| From | To | Assessment |
| --- | --- | --- |
| A1 engine (`engine.ts`) | `@vip/contracts` only | Pure and deterministic, as designed |
| A1 node / inputs | contracts; db measurements and preprocessing | Reads measurement data only; no transcription tables (`separation.spec.ts`) |
| A1 worker, A1 API service | `db/src/transcription.ts`: `getRun`, `beginStage`, `finishStage`, `findLatestSucceededPreprocessing` | Run and stage lifecycle functions only, no transcript data. **Existing accepted design.** These run-coordinator helpers live in the transcription module |
| `processing/measure.ts` | `runAudioTask` (shared provider helper), contracts (`INTERIM_TRANSCRIPTION_WINDOW`) | Reuses the shared audio-task path; the window grid is shared on purpose |
| `measure.py` | `transcribe.py` (`SileroDetector`, `pad_and_merge`), runner, isolation, storage | One VAD implementation is reused, not duplicated. **Existing accepted design** |
| Web A1 hook | `transcription/model.ts` (`POLL_MS` only) | Shares the polling constant only. **Future improvement** (a shared constant) |
| Entry points | `orchestrator.module.ts`, `app.module.ts`, `recording-detail.tsx`, `processing-status.tsx`, `timeline-placeholder.tsx`, audio `app.py` / `inference_child.py` | Every A1 component is connected. Nothing is disconnected |

**Classified findings**
- **Actual defects: none.**
  - The graph shows edges from API controllers to web files (`audio-quality-card.tsx`, `use-hero-3d.test.ts`).
    These are **extraction artefacts**: NestJS decorator names (`Body`, `Query`) resolved to unrelated symbols. No
    such import exists in the source.
- **Architectural concerns (minor):**
  - **`STAGE_NODES`:** a run-level enum, defined in `contracts/src/audio-quality.ts`. Later agents will extend it, so
    a neutral runs/stages contract module would suit A2–A7 better.
  - **Run and stage helpers:** they sit in `db/src/transcription.ts`. A6 and A7 will need them too.
  - Neither is a defect; both are recorded for the agent phase, not refactored now.
- **Existing accepted design:**
  - `createAudioQualityReader` has no consumer yet. It is the ADR-0046 read-only port, waiting for A2/A3.
  - The A1 → transcription-module edges listed above.
- **Future improvements:**
  - small helper duplication between `measure.py` and `measurements.py` (dB conversion, quantity builders);
  - the shared polling constant;
  - the optional SQL grammar, if migration parsing becomes useful (a new dev dependency; needs approval).

**Fit for A1–A7 and Phase 3C**
- **Shared and generic:**
  - agent stages share one stage table (`pipeline_stage_runs`) and enum (`STAGE_NODES`);
  - one BullMQ run coordinator;
  - one audio service with a typed task registry (`probe | preprocess | transcribe | diarize | measure`);
  - one database and one contracts package.
- **Adding an agent:** a new agent adds a stage node, a queue or graph node, and contracts. It needs no new database,
  orchestration engine or service.
- **A1–A7:** identities and numbering are unchanged. LangGraph remains the Phase 3B target (OD-04b, provisional).
- **Phase 3C:** machinery and environmental sound intelligence (ADR-0047) can add its own audio-service task types
  and its own stage or workflow on the same shared infrastructure, without duplicating it. The graph shows no
  coupling that would prevent this.
- **No refactoring was done.**
