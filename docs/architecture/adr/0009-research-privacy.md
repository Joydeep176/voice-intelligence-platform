# ADR-0009: Research stays mandatory, with query minimisation and privacy controls

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-20
- Affects: SRS FR-7.x, SEC-7; AGENT A4; DATABASE `research_queries`; API §3, §6

## Decision
Research remains a mandatory workflow step and cannot be disabled per run. Controls:
- No raw transcript excerpts in queries. Personal identifiers of private individuals are removed unless the claim needs them.
- Every query sent externally is recorded exactly as sent.
- Workspace-level domain allow/deny lists (*Proposed* mechanism).

## Consequences
The minimisation technique (rules vs model-assisted detection) is an implementation detail and must be tested. Provider choice: OD-05.
