# ADR-0002: Node/NestJS owns jobs; Python audio service behind an internal API

- Status: Accepted for the Node ↔ Python integration (OD-04a, prototype confirmed in Phase 2B, ADR-0040); "LangGraph orchestrates" remains Accepted provisionally until the agent phase (OD-04b)
- Date: 2026-11-19
- Resolves: OD-04
- Affects: HLD §4–5, LLD §2.3, §3.1, §5, DEPLOYMENT

## Context
Audio processing is in Python. Orchestration and queues are in Node. Runs over two hours must not block workers.

## Decision
- Node/NestJS owns BullMQ: all queues, job lifecycle, retries, progress.
- LangGraph (in the orchestrator) orchestrates the pipeline.
- Python is a separate audio-processing service with an internal API. It does not consume BullMQ and does not write to Postgres or Redis.
- The communication design must be **validated with a prototype** before it becomes a permanent implementation constraint.

## Prototype must validate (*Proposed* design in LLD §3.1)
Async task submission with idempotency keys; step-job polling without blocked workers; progress relay; cancellation; behaviour when the service restarts (lost tasks); memory/time limits on > 2 h audio; throughput.

## Accepted constraint (2026-11-19, from OD-23a)
The audio-service contract (task API, payloads, results) is framework-independent, defined as schemas in `packages/contracts` with mirrored Python models. Domain modules must not depend on the HTTP framework. FastAPI is the framework accepted provisionally (OD-23a, ADR-0023) until the prototype validates it.

## Consequences
Service-to-service authentication remains Open (OD-23b; update 2026-11-21: resolved for development by ADR-0035, production OD-23c Open). If the prototype fails, this ADR is revisited.
