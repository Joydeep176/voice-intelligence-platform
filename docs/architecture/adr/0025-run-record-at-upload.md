# ADR-0025: Run record created at upload, with status `created`

- Status: Accepted; consequences amended by ADR-0044 (2026-11-26)
- Date: 2026-11-19
- Resolves: OD-42
- Affects: DATABASE_DESIGN §4 (`pipeline_runs.status`), API §2–3, `packages/contracts`, `apps/api`, `apps/web`

## Context
The Phase 1 brief requires a processing-run record to be created when an upload completes. The documented run statuses (`queued|running|cancelling|cancelled|completed|failed|needs_review`) all imply that the run has been submitted to the pipeline. In Phase 1 no pipeline exists, so `queued` would claim work that will never happen.

## Options considered
1. **Add a `created` status**: honest, and makes the initial state explicit.
2. **Use `queued`**: no model change, but misleading.
3. **Create no run at upload**: matches API §3 (`POST /recordings/{id}/runs`), but deviates from the brief.

## Decision
The user chose option 1 on 2026-11-19:
- Completing an upload (`POST /recordings/{id}/upload/complete`) creates one `pipeline_runs` row with status **`created`**, meaning "recorded, not yet submitted to the pipeline".
- `created` precedes `queued`. Submitting the run to the pipeline (a later phase) moves it to `queued`.

## Consequences
- `pipeline_runs.status` is `created|queued|running|cancelling|cancelled|completed|failed|needs_review`.
- `POST /recordings/{id}/runs` (API §3) remains the way to start further runs, for example re-runs. Its interaction with an existing `created` run is decided when the pipeline is implemented.
- The UI states plainly that a `created` run has not been processed.
- A `created` run can be cancelled but not retried (it has never failed).

## Amendment (2026-11-26, ADR-0044, D-3A-03)
- A1 may run on a `created` run once its preprocessing measurements are terminal.
- An A1 failure there can be retried as an A1-only re-assessment. This is not a run retry, so the run itself is still
  not retried.
- Cancelling a `created` run (allowed above) also stops a pending or running A1 stage and keeps completed diagnostics.
- The UI wording for a `created` run with diagnostics is "Audio assessed; transcription has not been started".
