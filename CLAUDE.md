# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Multilingual (English / Hindi / Hinglish) AI Voice Intelligence Platform. **Documentation and decisions only: no application code, scaffolding or dependencies exist yet. Application implementation has NOT been approved.** Do not create source code, install dependencies, provision infrastructure or connect providers without explicit user approval. Never describe an integration as implemented or tested unless its code and passing tests exist.

## Source of truth

| Topic | Document |
|---|---|
| Requirements (FR / SEC / OPS / NFR IDs) | `docs/SRS.md` |
| Overview, approved stack, **decisions register (OD-xx)** | `docs/architecture/HLD.md` §10 |
| Decisions | `docs/architecture/adr/` |
| Modules, layout, internal audio API, adapters, queues, run control | `docs/architecture/LLD.md` |
| Seven product agents, boundaries, graph | `docs/architecture/AGENT_ARCHITECTURE.md` |
| Schema, ownership, deletion | `docs/architecture/DATABASE_DESIGN.md` |
| REST API | `docs/architecture/API_SPECIFICATION.md` |
| Compose / AWS | `docs/architecture/DEPLOYMENT_ARCHITECTURE.md` |
| Test runners and required tests | `docs/architecture/TESTING_STRATEGY.md` |

Statuses are Accepted, Accepted provisionally, Interim, Proposed and Open. Anything tagged *Proposed*, or an OD with status Open or Proposed, is **not approved**. Never resolve it implicitly in code. Ask the user, then use the `record-architecture-decision` skill.

## Architecture essentials

- Seven product agents (ADR-0001, ADR-0019): Audio Quality (diagnostics) · Transcription (incl. language ID, diarization, uncertainty) · Context Intelligence · Research · Fact Validation · Reporting · QA (independent, read-only). Decoding, normalisation, VAD and segmentation are a deterministic audio-service stage, **not** an agent. These are unrelated to the dev subagents in `.claude/agents/`.
- Node/NestJS owns BullMQ and the job lifecycle. LangGraph orchestrates. Python is a separate audio service behind an internal API (ADR-0002, provisional until prototyped).
- Non-negotiables: immutable provider output with versioned corrections and derivations (ADR-0007); `recorded`/`external`/`inferred` provenance on every report assertion; audio diagnostics kept separate from transcription uncertainty; snapshot evidence (never snippets) for verdicts; workspace isolation; bounded workers and cost ceilings.
- Tooling (ADR-0005, not yet scaffolded): pnpm + Turborepo, uv, Drizzle. Test runners: Vitest (web, `packages/*`), Jest (NestJS apps), Pytest (audio service), Playwright (e2e).

## Commands

None yet. Add build, lint, test and single-test commands here when scaffolding is approved and created.

## Working rules

- Preserve existing behaviour. Keep changes scoped to the task. No unrequested refactors.
- After each change, run the most targeted relevant tests first, then the affected package's suite (see the `verify-change` skill). Report results faithfully, including failures.
- Never skip, delete, loosen or rewrite tests just to get a passing result.
- Never put secrets, credentials, raw recordings or transcript text in code, logs, test output, commits or docs. Use only synthetic or consented fixtures (ADR-0004). `.claude/settings.json` denies reading and editing env files, keys and local recording storage; do not work around it (for example via shell commands).
- Update the relevant doc in the same change when behaviour described there changes.
