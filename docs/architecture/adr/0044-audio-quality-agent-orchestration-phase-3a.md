# ADR-0044: A1 orchestration and placement in Phase 3A

- Status: **Accepted** (user decision, 2026-11-26, including the D-3A-03 change to ADR-0025's consequences). First written as Proposed in the Phase 3A plan
  (2026-11-26)
- Date: 2026-11-26
- Addresses: OD-50 (new); interacts with OD-04b (LangGraph, Accepted provisionally), OD-32 / ADR-0021 (A1 ∥ A2,
  Accepted provisionally), ADR-0025 (`created` run), ADR-0008; plan decisions D-3A-02, D-3A-03 and D-3A-06. D-3A-05
  (consumption) moved to ADR-0046 (revised 2026-11-26)
- Affects: AGENT_ARCHITECTURE §2; LLD §5–§6; `packages/contracts` (new `STAGE_NODES`, node-boundary schemas; `RUN_STAGES` unchanged); `apps/orchestrator`; `apps/api`;
  `apps/web`

## Context

- **Current orchestration:**
  - No LangGraph and no agent code exist. OD-04b says that LangGraph orchestrates, but nothing exercises it yet.
  - The run is one sequential `run-transcription` BullMQ job; `RUN_STAGES = [transcription, diarization]`.
  - Transcription is started manually. The run exists from upload in status `created` (ADR-0025).
- **ADR-0021** requires A1 and A2 to be independent and parallel after preprocessing, neither consuming the other's
  output, with an A1 failure blocking only Reporting. ADR-0046 (Accepted) allows read-only metadata access
  without waiting.
- **The Phase 3A brief** asks that A1 assess audio *before* downstream processing, support "proceed / proceed with
  warnings / require user intervention", and be consumable by A2. These requests partly conflict with ADR-0021,
  FR-3.5 and ADR-0008.

## Options considered

**Orchestration framework (D-3A-02):**
- (a) Introduce LangGraph in 3A. This refactors the accepted 2B/2C coordinator for one deterministic node.
- (b) Add A1 as a BullMQ-driven stage in the existing coordinator pattern, and introduce LangGraph through a prototype
  at Phase 3B, the first LLM agent and first agent chain.

**When A1 runs (D-3A-03):**
- (a) On the `created` run, as soon as the measurements exist, before the user starts transcription.
- (b) Only inside a submitted run, concurrently with A2, as ADR-0021 is written.

**A1 output consumption (D-3A-05):** covered separately by ADR-0046 (Accepted): read-only metadata availability,
with no automatic blocking or skipping.

**Run status (D-3A-06):**
- (a) Run completion stays defined by the transcription scope; the A1 stage has its own status and retry.
- (b) A run completes only when A1 is terminal too.

## Decision

**D-3A-02 (b), D-3A-03 (a), D-3A-06 (a).**

- **One orchestration target.** BullMQ is used for the Phase 3A implementation inside the existing run coordinator,
  and A1 gets no separate orchestration system. The shared LangGraph graph remains the target for the whole platform
  (OD-04b, unchanged).
- **Framework-independent node boundary.** A1's node input, output and state slice are framework-independent schemas
  in `packages/contracts`. The BullMQ job is an adapter, so A1 joins the shared graph as a node without redesign.

- **A1 runs as its own BullMQ job** (`aq-<runId>`) with an `audio_quality` row in `pipeline_stage_runs`. The node is a
  pure function behind a diagnostics-only repository, so it can be wrapped as a LangGraph node later without changes.
- **It runs on the `created` run** once the preprocessing measurements are terminal. That gives the user the
  assessment before deciding to transcribe.
  - This refines what `created` means (A1 may run on it) but does not submit the run; transcription still needs the
    user's start.
  - Nothing is stopped automatically (ADR-0008).
- **A2 never waits for A1**, and an A1 failure never affects transcription. Whether A2 and A3 may *read* the A1
  summary as metadata is ADR-0046 (Accepted). In 3A, A2's behaviour is unchanged.
- **Concurrency:** in 3A, A1 normally finishes before transcription starts. This is a logical, not a temporal,
  parallelism; on this hardware the audio service runs one task at a time and A1's classification costs milliseconds.
  The ADR-0021 graph-level validation stays outstanding until the graph layer exists (3B).

## Consequences

- A separate stage-node enum gains `audio_quality`. `RUN_STAGES`, the transcription run scope, is unchanged.
  `finishCancelled` and the sweeper close only open stages. (Correction 2026-11-26: an earlier wording here said A1
  is not cancelled with transcription; that contradicted the lifecycle rule L5 below, which governs: cancelling a run
  stops a pending or running A1 stage and keeps completed diagnostics.)
- **Lifecycle:** the canonical rules are L1–L10 in `docs/development/phase3a/A1_DESIGN.md` §2.3.1.
  - **Pinning:** diagnostics are pinned to the assessed preprocessing version. At submission, A1 re-assesses if no
    completed diagnostics exist for the run's version.
  - **Failure:** an A1 failure never changes run status.
  - **Cancellation:** cancelling a run (including a `created` run, which ADR-0025 already allows but the code rejects
    today) stops a pending or running A1 stage and keeps completed diagnostics. It does not cancel the
    preprocessing-scoped `measure` task.
  - **Retry:** an A1-only retry, bounded by a configured cap, does not count as a run retry.
- **ADR-0025 consequences change** (needs the user's approval with this ADR): A1 can run, fail and be retried
  (A1-only) on a `created` run, and the UI wording becomes "Audio assessed; transcription has not been started".
- **API:** it exposes `GET /api/v1/workspaces/{workspaceId}/runs/{runId}/audio-diagnostics` (API §4, workspace-scoped)
  and, if approved, `POST …/runs/{runId}/audio-diagnostics/retry`.
- ADR-0021 stays Accepted provisionally. Its graph validation moves to the Phase 3B graph-layer prototype, together
  with OD-04b.
- Any automatic skip or block of transcription on A1 output would need a separate ADR amending ADR-0008. None is
  proposed.
- At A6 (the A1 + A5 join) the run-completion semantics are revisited.

## Amendment (user decision, 2026-11-26)

A1 is not triggered on a terminal measurement set. The A1 job itself first ensures the set (ADR-0045 amendment) and
then assesses; a measure failure never fails A1. JobIds are `aq-<runId>-<attempt>`.

## Amendment 2: accepted lifecycle deviations (user decision, 2026-11-26, Phase 3A acceptance)

The user accepted the three as-built deviations from lifecycle rules L2, L3 and L6 (`A1_DESIGN.md` §2.3.1), recorded
in `A1_DESIGN.md` §9 notes 4, 10 and 11. They amend those rules. Nothing else in the lifecycle changes.

**1. Trigger sweep (amends L2).**

*Behaviour:*
- A repeatable sweep (`AUDIO_QUALITY_SWEEP_INTERVAL_MS`, 15 s) finds `created`, `queued` or `running` runs that have a
  succeeded preprocessing version and no A1 stage, then enqueues `aq-<runId>-<attempt>`.
- The A1 job first ensures the measurement set and then assesses.
- A failed measurement set gives the documented Tier 0 behaviour: Tier 1 dimensions are listed as not assessed, and
  confidence is `low`.

*Rationale:* there are no hooks in the accepted Phase 2B preprocess path or the Phase 2C submission path, which stay
unchanged.

*Implication:* latency from a completed preprocessing to an assessment is up to one sweep interval plus the measure
time.

*Safeguards:*
- the jobId is idempotent;
- the sweep is batch-limited;
- the per-run attempt cap applies (`AUDIO_QUALITY_MAX_ATTEMPTS`);
- stuck stages are failed with `A1_STALLED` and not re-enqueued.

**2. A1-only retry eligibility (amends L6).**

*Behaviour:* `POST …/audio-diagnostics/retry` is allowed when:
- there is no previous A1 stage; or
- the latest A1 stage is `failed` or `cancelled`; or
- the completed A1 stage is for a different preprocessing version.

It is refused (409) when:
- the run is `cancelling` or `cancelled`;
- an assessment is running;
- a completed assessment exists for the pinned version; or
- the attempt cap is reached.

*Rationale:* this lets runs created before Phase 3A, and stages cancelled with a run, obtain an assessment.

*Safeguards:*
- attempts are bounded by `AUDIO_QUALITY_MAX_ATTEMPTS`;
- cancellation is checked;
- duplicates collapse onto one jobId;
- the retry is audited;
- an A1-only retry never changes the run's `retry_count` (ADR-0025: a `created` run is still not retried as a run).

**3. Re-assessment after submission (amends L3 / L7).**

*Behaviour:* when a submission or run retry pins a preprocessing version and no completed A1 diagnostics exist for
that exact version, the sweep enqueues a new A1 attempt. It does so whatever the latest A1 stage status is, but not
while one is running, and under the attempt cap.

*Rationale:* a `created` run may have been assessed against a different version than the one pinned at submission.

*Safeguards:*
- results are pinned to the assessed `preprocessing_id`;
- diagnostics are insert-only, unique per (run, attempt) and protected by immutability triggers, so existing
  completed results are never overwritten;
- the idempotent jobId and the per-attempt row prevent duplicate effective assessments;
- cancelled runs are excluded;
- consumers read only diagnostics whose `preprocessing_id` equals the run's: the API resolves the pinned version, and
  `AudioQualityReader.get` requires `preprocessingId`.

*Implication:* transcription is never delayed or blocked by any of the three (ADR-0021).
