# ADR-0010: Bounded worker limits

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-21
- Affects: SRS OPS-1–7, LLD §5, §8, DEPLOYMENT §2

## Decision
Bounded processing is required: per-queue and per-service concurrency limits, job/task timeouts, bounded retries with backoff, stalled-job detection and recovery, retained failed jobs, per-run fan-out caps, per-run cost ceilings, and hard loop caps.

## Consequences
Concrete values are configuration, set during implementation and benchmarking. Behaviour when the cost ceiling is reached: OD-28 (Proposed).
