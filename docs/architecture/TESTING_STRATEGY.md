# Testing Strategy

Status: **Approved tools and allocation. Tooling set up in Phase 1** (Vitest 5, Jest 30 with `--experimental-vm-modules`, Pytest 9, Playwright). Integration tests use the Compose Postgres (`*_test` database, reset per run) and Redis logical DB 15. Commands: `docs/development/SETUP.md` §5.

## 1. Tool allocation

| Tool | Scope |
|---|---|
| **Vitest** | `apps/web` (with Testing Library) and all TypeScript packages under `packages/*` (e.g. `contracts`, `db` helpers) |
| **Jest** | NestJS apps: `apps/api`, `apps/orchestrator` (unit, integration, e2e via supertest) |
| **Pytest** | `services/audio` (processing modules and internal API contract). FFmpeg, Landlock, `/proc` and hardening tests carry a container marker: they are **skipped on the host** (`pnpm audio:test`, no FFmpeg there) and run in the hardened image with `pnpm audio:test:container`; Compose hardening checks need `AUDIO_SERVICE_TEST_DOCKER=1`. The §6 untrusted-media controls and the malicious-media suite are exercised only by the container run (Phase 2B) |
| **Playwright** | Browser end-to-end against the Compose stack; automated accessibility checks with `@axe-core/playwright` (dev only, ADR-0029) |

Each package uses exactly one runner. Do not mix runners within a package.

## 2. Test layers

1. **Unit**: stitching, speaker alignment, block-wise metrics, config hashing (ADR-0015), provenance validation, evidence-sufficiency rules, graph routing (research retry cap, QA loop cap), budget checks.
2. **Agent/node**: each agent with a fake LLM and fake adapters, against its contract (AGENT_ARCHITECTURE §4), including schema-repair paths and idempotent re-runs.
3. **Graph**: the full graph with all externals faked: happy path, poor audio continuing with limitations, undecodable audio, unresolved claims → exactly one research retry, QA failure path, cancellation mid fan-out, crash and resume from checkpoint, budget exceeded.
4. **Integration**: real Postgres and Redis in containers. Migrations; BullMQ flows; step-job polling of the audio service; stalled-job recovery; progress propagation end to end (ADR-0018).
5. **Contract**: shared provider contract suites (STT, diarization, research) run against fakes and recorded fixtures. Audio-service API contract tests (zod ↔ Python models). Live provider calls are opt-in only.
6. **E2E (Playwright)**: consented upload → run → transcript, correction and display name → report with provenance badges → export, all with fake providers.

## 3. Requirement-driven tests (must exist before the related feature is called done)

| Requirement | Test |
|---|---|
| FR-4.4 raw output immutable | Update/delete attempts on raw outputs and machine versions fail; a correction creates a new version, and the raw output hash is unchanged |
| FR-9.2 provenance | Report with an assertion lacking valid refs → rejected / QA issue |
| FR-3.3 / FR-9.3 separation | Diagnostics and uncertainty are stored and rendered separately; A1 cannot read transcription tables; no other component writes diagnostics tables; A2/A3 read A1 data only through `AudioQualityReader` and never wait for it; transcription output is identical with the A1 context present, absent or failed (ADR-0046); QA flags conflation |
| FR-2.4 / FR-2.5 deterministic preprocessing | Same input + config + tool versions → same hash and identical segments and measurements; a stored hash always has its config and tool-version metadata; the preprocessing node makes no LLM calls |
| FR-3.5 / ADR-0021 parallel branches | Graph-level validation: A1 and A2 run concurrently after preprocessing; A3 starts without waiting for A1; A6 starts only after A1 and A5; neither branch receives the other's output; a failure in either branch blocks A6; cancellation stops both |
| FR-12.4 corrected-transcript runs | A new run references its source version and parent run; the parent run's outputs are unchanged |
| FR-8.2 evidence | `snippet_only` source cannot back `supported` |
| SEC-2 isolation | Every endpoint returns `404` for another workspace's resources (parameterised over all routes) |
| SEC-6 deletion | After deletion, no rows, objects, checkpoints or jobs remain for the recording |
| SEC-9 hygiene | Log capture during pipeline tests contains no transcript fixture text |
| OPS-1–7 bounds | Timeouts, retry caps, fan-out cap and cost ceiling enforced |
| NFR-7 memory | Audio service preprocessing, measurement and (self-hosted) diarization stay within the memory budget on generated recordings well beyond 2 h; peak memory does not grow with duration beyond the configured bound |

## 4. Quality evaluation (separate from pass/fail tests)

- VAD benchmark (OD-29): WebRTC VAD vs Silero VAD on en/hi/Hinglish and degraded audio (speech/non-speech accuracy, effect on segmentation, CPU/memory). **Done on the synthetic corpus** (`docs/development/phase2b-vad-benchmark/`); selection recorded in ADR-0038.
- STT benchmark: WER (en), CER/WER (hi), code-switch-aware evaluation (Hinglish). Diarization benchmark: DER, including > 2 h recordings. **Done on the synthetic corpus** (`docs/development/phase2c-stt-benchmark/`, `docs/development/phase2c-provider-validation/`); selections recorded in ADR-0036 and ADR-0037. The real-speech benchmark with the OD-18 corpus is follow-up work (ADR-0040). Corpus: OD-18.
- LLM golden sets: claim extraction, verdicts, provenance assignment, QA detection, per prompt version and model.
- Long-audio soak: synthetic > 2 h audio, forced worker and audio-service restarts, resume.

## 5. Rules

- Default runs make no real calls to Claude, STT, diarization or research providers.
- Fixtures are synthetic or consented (ADR-0004). Small fixtures are committed; long ones are generated. No real recordings or private transcripts in the repo.
- Every bug fix gets a regression test at the lowest layer that reproduces it.
- Tests must never be skipped, deleted or weakened to get a passing run.

## 6. Phase 2B additions

- Real-stack end-to-end suite: `pnpm test:phase2b:e2e` (`tests/phase2b-e2e/`; API + orchestrator + hardened audio container against the `*_test` database, Redis DB 14 and a throwaway storage root).
- Resource benchmarks: `pnpm bench:phase2b:resources` (`docs/development/phase2b-resources/`).
- VAD candidate benchmark (synthetic TTS corpus): `services/audio/benchmarks/vad/` (`docs/development/phase2b-vad-benchmark/`).
- Timestamp validation: `services/audio/benchmarks/timestamps/` (`docs/development/phase2b-timestamps/`).

## 7. Phase 2C additions (self-hosted providers)

- **Real-provider browser checks** (manual, against the running dev stack with `STT_PROVIDER=whisper-cpp` and
  `DIARIZATION_PROVIDER=sherpa-onnx`):
  - happy path: `run-real.mjs`;
  - failure paths (invalid and unsupported media, duplicate submission, cancel/retry, audio-service outage, dense and
    fragmented speech): `run-failures.mjs`;
  - following a run to its end: `watch-run.mjs`.
  - All three scripts and their numbers-only results are in
    `docs/development/phase2c-provider-validation/e2e-real-providers-2026-11-25/`.
  - Synthetic inputs only.
  - They are not CI tests: they need the real models and take minutes per run.
- **Real-service checks:** run the audio image in a throwaway container at the production limits, polling liveness
  during inference:
  - STT windows (`stt-speed-2026-11-24/real-check-2cpu-2026-11-25.json`);
  - the 60 min bounded-memory diarization run (`diarize-60min-bounded-memory-2026-11-25/`).
- **Accuracy gate for STT changes:** a change to the decode path must be re-scored on the C3 test split, per language
  and SNR, before adoption. Example: E7 rejected a sized `audio_ctx`
  (`stt-speed-2026-11-24/e7-audio-ctx-accuracy-2026-11-25.log`).
- **C3 benchmark:** `services/audio/benchmarks/stt/run.py` (`report` regenerates `docs/development/phase2c-stt-benchmark/`).

## 8. Phase 3A additions (A1 Audio Quality)

- **Unit:** A1 rule engine (`apps/orchestrator/src/agents/audio-quality/engine.spec.ts`: table-driven rules,
  monotonicity, determinism, not-assessed handling); static A1/A2 separation (`separation.spec.ts`); `measure` task
  (`services/audio/tests/test_measure.py`); contracts and shared `measure-*` fixtures; web card, step and timeline
  track tests.
- **Integration:** migration 0005 (`packages/db/test/audio-quality.int.test.ts`); A1 worker lifecycle and Tier 1
  (`apps/orchestrator/test/audio-quality.int-spec.ts`); API (`apps/api/test/audio-quality.int-spec.ts`).
- **Production-task validation (not CI):** `services/audio/benchmarks/quality/task-check.mjs` (real `measure` task in
  the production image at 2 CPUs / 768 MB, 4 h file, cancellation, determinism).
- **Benchmarks (not CI):** M0 harness (`services/audio/benchmarks/quality/run.py`) and M6 engine evaluation, evidence in
  `docs/development/phase3a-quality-benchmark/`. Synthetic only; never real-world accuracy.
- **Browser E2E (manual, real stack):** `docs/development/phase3a-quality-benchmark/e2e/run-a1.mjs`.
