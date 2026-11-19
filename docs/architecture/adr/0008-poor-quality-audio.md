# ADR-0008: Poor-quality audio does not stop processing

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-19
- Affects: SRS FR-3.4, AGENT §2, DATABASE `pipeline_runs.has_limitations`

## Decision
Poor-quality audio does not automatically stop processing. The pipeline continues where possible and reports the limitations. A run fails only if no usable audio can be decoded.

## Consequences
The previous `failed_quality` status is removed. The report's audio-limitations section is mandatory when flags exist.
