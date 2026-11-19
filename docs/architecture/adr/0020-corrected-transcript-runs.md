# ADR-0020: Traceable processing of corrected transcripts

- Status: Accepted (principle). The mechanism below is Proposed (OD-26b).
- Date: 2026-11-19
- Resolves: OD-26a
- Affects: SRS FR-12.4, DATABASE `pipeline_runs`, API §3, AGENT §2

## Decision (accepted)
Processing a corrected transcript must create traceable transcript versions and new processing runs. Earlier runs and their outputs are never modified.

## Proposed mechanism (not accepted, OD-26b)
A new run with `source_transcript_version_id` and `parent_run_id` starts at the Context Intelligence Agent. It reuses the parent's preprocessing version and audio diagnostics by reference, and records the lineage in its config snapshot.
