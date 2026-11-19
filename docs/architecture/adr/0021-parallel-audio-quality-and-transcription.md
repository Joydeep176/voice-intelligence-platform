# ADR-0021: Parallel Audio Quality and Transcription after preprocessing

- Status: Accepted provisionally (subject to graph-level validation)
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
