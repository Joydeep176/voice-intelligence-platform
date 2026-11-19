# ADR-0011: Defer embeddings

- Status: Interim
- Date: 2026-11-19
- Resolves: OD-06 (interim: no embeddings for now; a final decision needs a demonstrated use case)
- Affects: HLD §7, DATABASE, LLD providers

## Decision
No embedding model or embedding tables until a retrieval use case is demonstrated. The pgvector extension stays part of the approved stack.

## Consequences
LLM stages use full-context or hierarchical processing within budget (ADR-0013). Revisit with evidence (cost or quality) through a new ADR.
