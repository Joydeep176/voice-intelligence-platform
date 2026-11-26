# ADR-0046: A1 `AudioQualitySummary` as read-only metadata for A2, A3, A6 and A7

- Status: **Accepted** (user decision, 2026-11-26). First written as Proposed in the Phase 3A plan from the user's
  architecture-review corrections (2026-11-26)
- Date: 2026-11-26
- Addresses: OD-54 (new); plan decision D-3A-05
- **Amends** (all currently Accepted or Accepted provisionally):
  - SRS FR-3.5;
  - ADR-0019 ("neither agent reads or writes the other's");
  - ADR-0021 ("cannot overwrite or consume each other's output");
  - AGENT_ARCHITECTURE §1 Boundaries ("A2 … never reads or writes audio diagnostics"), §2.1, §2.2, §3 and §4;
  - TESTING_STRATEGY §3 (the FR-3.3 / FR-9.3 separation test).
- Unchanged: FR-3.3, FR-3.4 / ADR-0008, FR-9.3, ADR-0007, and accepted Phase 2B/2C behaviour.

## Context

- **What the user asked for** (Phase 3A review corrections, 2026-11-26): A1's versioned summary should be available
  as read-only metadata to:
  - A2: audio-quality constraints and affected time ranges;
  - A3: reliability context for transcript-derived information;
  - A6: audio limitations and caveats;
  - A7: consistency checks.
- **What the user excluded:** automatic blocking or skipping of transcription, audio enhancement, and changes to
  accepted 2B/2C behaviour.
- **What the accepted records say today:**
  - A2 never reads diagnostics, and neither agent consumes the other's output (FR-3.5, ADR-0019, ADR-0021, AGENT §1
    and §2.2).
  - A3 does not depend on A1 (AGENT §2.1).
  - A6 already joins on A1 and A5, and A7 already reads all report artefacts.
  - The A6 and A7 parts therefore need no amendment. The A2 and A3 parts do.

## Three distinctions this ADR keeps explicit

| | Meaning | A2 | A3 | A6 | A7 |
| --- | --- | --- | --- | --- | --- |
| **Metadata availability** | It *may* read the summary (and flag time ranges) through a read-only port when one exists for the run's preprocessing version | Yes (proposed) | Yes (proposed) | Yes | Yes |
| **Execution dependency** | It *waits* for A1 before starting | **No** | **No** | Yes (existing join) | Yes, through A6 |
| **Behavioural coupling** | Its processing changes because of A1's values | **None in Phase 3A**; any future use needs its own ADR plus the E7-style accuracy gate | **None** until A3's own design (3B) defines it, under this ADR's rules | Report content (by design) | Checks (by design) |

## Options considered

1. **Keep full independence** (the earlier plan proposal). It contradicts the user's request.
2. **Read-only metadata availability with no execution dependency and no behavioural coupling in Phase 3A**, plus
   guard rails that preserve FR-3.3 / FR-9.3.
3. **A2 and A3 depend on A1 and adapt to it.** It adds an execution dependency, A1 failures would block
   transcription, and behaviour would change. Excluded by the user.

## Decision

**Option 2.**

**Contract**
- `AudioQualitySummary` v1 plus a time-range flag view (`AudioQualityContext`: summary plus
  `{kind, severity, startMs, endMs}` per flag).
- These are zod schemas in `packages/contracts`, framework-independent and versioned (`schemaVersion`).
- They are the **only** A1 shapes other agents may read. Internal rule data, measurement references and the rule
  configuration are not part of them.

**Access**
- A read-only `AudioQualityReader` port that returns the context for (run, preprocessing version), or
  `{ status: 'unavailable' | 'pending' | 'failed' }`.
- Agents receive it through their node input, as an *optional* field. Shared state carries only `audioQuality`
  (`diagnosticsId`, `overall`, `confidence`), written by A1.
- No agent other than A1 can write diagnostics tables, and A1 still never reads transcription data.

**No waiting**
- A2 and A3 start on their own required inputs (AGENT §2.1, unchanged).
- If A1 is pending, failed or absent, they proceed. They record that the context was `unavailable`; they do not retry
  or wait.

**Guard rails** (to keep FR-3.3 / FR-9.3)
- A2 must **not** derive, create, change or suppress transcription uncertainty records from A1 data, and A1 must not
  use transcription data. The two data models stay separate.
- A consumer may store only a *reference* to the diagnostics it saw (`diagnosticsId`), in its own records, for
  traceability. It never copies flags into its own outputs as its own findings.
- Reports keep diagnostics and uncertainty in separate sections (FR-9.3). A7 checks that they are not conflated.

**Phase 3A scope**
- Phase 3A delivers the contract, the reader port, the state slice and tests.
- A2's code and outputs are unchanged. A2 is not yet an agent node, and no A2 behaviour reads the summary. A3 is not
  implemented.
- This satisfies "availability" without behavioural coupling.

## Amendment text (applied 2026-11-26)

- **FR-3.5:** "After preprocessing, audio quality analysis and transcription run independently (ADR-0021). Neither
  waits for or overwrites the other's output. Transcription and later agents may read the Audio Quality Agent's
  versioned summary as optional, read-only metadata (ADR-0046); transcription output is never an input to audio
  quality analysis. Downstream stages start only when their required upstream results are complete."
- **ADR-0019 / ADR-0021 / AGENT §1, §2.2:** "Neither agent writes the other's data. A1 never reads transcription data.
  A2 may read A1's `AudioQualitySummary` / `AudioQualityContext` read-only through `AudioQualityReader`, without
  waiting for it and without deriving uncertainty from it (ADR-0046)."
- **AGENT §2.1:** a note that A2 and A3 have *optional* metadata inputs from A1, with no change to their required
  upstream results.
- **TESTING §3:**
  - A1 cannot read transcription tables.
  - A2 and A3 can read only the A1 reader port, never diagnostics tables directly and never writably.
  - A2 output is identical with the context present, absent or failed (Phase 3A).

## Consequences

- Amendments to SRS FR-3.5, ADR-0019, ADR-0021 (its "Validation required" list gains: "A2 never waits for A1; A2
  output is unaffected by the presence of A1 context"), AGENT §1–§4 and TESTING §3, recorded through
  `record-architecture-decision`.
- ADR-0021's parallel topology and its provisional status are otherwise unchanged.
- The A2 agent-ification phase must decide, under its own ADR, whether A2 uses the context at all. An example would
  be annotating time ranges for reviewers. Any use that changes transcription output also needs the accuracy gate.
- A3 (Phase 3B) may use the context only as *reliability metadata* attached to claims (for example "claim span
  overlaps a high-severity noise flag"), stored as references, never as a change to quoted text or claim extraction
  logic, unless a 3B ADR decides otherwise.
