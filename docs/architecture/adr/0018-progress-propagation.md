# ADR-0018: Progress propagation from workers to the frontend

- Status: Accepted provisionally (validate in the ADR-0002 prototype; client transport remains OD-16)
- Date: 2026-11-19
- Addresses: review findings I-03/I-04, correction E8
- Affects: LLD §5, API §3, SRS FR-11.1

## Decision (provisional)
1. Audio service: task progress (`fraction`, `processedMs`, `stage`) via `GET /v1/tasks/{id}`.
2. Orchestrator `audio-task` job: polls (step-job pattern), calls `job.updateProgress(...)`, and writes `pipeline_stage_runs.progress`. Other workers report progress the same way.
3. API: subscribes to BullMQ `QueueEvents` (progress / completed / failed), maps them to run events, and authorises by workspace.
4. Client: initial snapshot from `GET /runs/{id}`, then the event stream (transport OD-16, Proposed SSE) with polling fallback.

## Consequences
Snapshots from the DB make reconnects safe. Events carry IDs, stage and progress only, no content. Polling vs callbacks from the audio service is validated in the ADR-0002 prototype.
