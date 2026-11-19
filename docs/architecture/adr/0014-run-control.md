# ADR-0014: Cancellation, retry and targeted research retry

- Status: Accepted
- Date: 2026-11-19
- Resolves: approved corrections E1 and E2 (ARCHITECTURE_REVIEW)
- Affects: SRS FR-8.3, FR-11.2–11.3; LLD §6; API §3; AGENT §2

## Decision
- Cancel and retry are supported. Cancellation is safe: no new work starts, in-flight work is cancelled or discarded, and artefacts stay consistent. Retries are bounded (configured maximum per run; job-level retries bounded separately).
- Unresolved claims get exactly **one** targeted research retry per run.

## Consequences
The cancellation mechanics in LLD §6 are *Proposed* details.
