# ADR-0017: Question-level research adapter with snapshot evidence

- Status: Accepted
- Date: 2026-11-19
- Addresses: review finding I-08, correction E7
- Affects: LLD §3.2, AGENT A4/A5, DATABASE research tables

## Context
A `search`/`fetch` interface cannot represent server-side search tools. SRS FR-8.2 requires real evidence, not snippets.

## Decision
`ResearchProvider.research(questions, constraints)` returns the queries issued and the sources, each with retrieval type (`fetched` or `snippet_only`), a content snapshot (URI + hash) and verbatim passages. If a provider returns only snippets, the adapter fetches and snapshots the source. Only `fetched` sources can support or contradict a claim.

## Consequences
Works for both server-side tool and client-side implementations. Provider choice: OD-05 (Open). Retention and copyright handling of source snapshots are governed by the privacy and copyright decisions in OD-09b (Open).
