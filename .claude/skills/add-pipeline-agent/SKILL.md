---
name: add-pipeline-agent
description: Procedure for implementing or modifying one of the seven LangGraph product agents (Audio Quality, Transcription, Context Intelligence, Research, Fact Validation, Reporting, QA). Use when creating an agent node or changing its contract, prompts, state fields or graph edges. Requires implementation approval.
---

# Implementing or changing a product agent

Read first: AGENT_ARCHITECTURE §1 (boundaries), §2 (graph), §4 (contracts), §5 (LLM rules); LLD §5–7.

## Guardrails
- Seven agents only (ADR-0001). Do not change the roster.
- Respect the boundaries (ADR-0019): preprocessing is a deterministic node, not an agent; diagnostics (Audio Quality) vs transcription, language ID, diarization and uncertainty (Transcription); QA read-only; raw provider output immutable.
- Vendors, models, thresholds and caps come from config. If a value is an Open OD, ask the user.

## Steps
1. Confirm the contract (inputs, artefacts, state delta). If it changes, update the doc first.
2. Define zod schemas in `packages/contracts` (structured output, job payloads); mirror any audio-service types in Python.
3. Implement the node in `apps/orchestrator/.../agents/<agent>/`: load by reference; check cancellation; write idempotently keyed by (run, node, attempt); return the state delta only.
4. LLM via the factory (budget check + `llm_calls`). Delimit untrusted content. Validate with bounded repair retries.
5. For output that reaches the report, attach provenance and refs (recorded → spans, external → evidence, inferred → basis + confidence).
6. Wire edges with hard caps (research retry = 1).
7. Update DATABASE_DESIGN and migrations if persistence changes.
8. Tests (Jest): node tests with fakes (happy path, repair, cancellation, idempotent re-run, boundary violations rejected), plus graph routing tests. Then run them per the `verify-change` skill.
9. Ask for an `architecture-reviewer` review with the changed file list.
