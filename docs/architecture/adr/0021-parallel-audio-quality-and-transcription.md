# ADR-0021: Parallel Audio Quality and Transcription after preprocessing

- Status: Accepted provisionally (subject to graph-level validation); amended by ADR-0046 and ADR-0044 (2026-11-26)
- Date: 2026-11-19
- Resolves: OD-32
- Affects: AGENT_ARCHITECTURE §2, HLD §7, SRS FR-3.5, TESTING §3

## Decision
- After deterministic preprocessing, the Audio Quality Agent and the Transcription Agent run independently and in parallel.
- Downstream agents wait for their required upstream results (AGENT_ARCHITECTURE §2.1). Reporting waits for both branches.
- The two agents cannot overwrite or consume each other's output (inputs, state keys and repositories are separated, AGENT_ARCHITECTURE §2.2).

## Validation required
Graph-level tests must show concurrent execution, correct join behaviour, no cross-branch data access, failure propagation and cancellation of both branches before this becomes a permanent constraint.

## Consequences
Lower end-to-end latency. A1 failures block Reporting, not A3–A5.

## Amendment (2026-11-26, ADR-0046, ADR-0044)
- "Cannot overwrite or consume each other's output" now reads: neither *waits for* or overwrites the other's output.
  A2 may read A1's summary as optional read-only metadata (ADR-0046).
- **Validation required** gains two items: A2 never waits for A1, and A2 output is unaffected by the presence of the A1
  context.
- In Phase 3A, A1 runs on the `created` run before transcription is started (ADR-0044). The graph-level validation
  moves to the Phase 3B graph-layer prototype.
