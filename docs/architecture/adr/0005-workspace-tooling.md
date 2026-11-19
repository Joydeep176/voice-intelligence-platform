# ADR-0005: pnpm, Turborepo, uv and Drizzle ORM

- Status: Accepted provisionally (pgvector compatibility verification pending)
- Date: 2026-11-19
- Resolves: OD-11
- Affects: LLD §1, DATABASE, CLAUDE.md, `.claude/rules/database.md`

## Decision
pnpm workspaces + Turborepo (JS/TS), uv (Python), Drizzle ORM + Drizzle Kit migrations (PostgreSQL).

## Required before implementation
Verify Drizzle support for the pgvector `vector` type and extension migrations on the target PostgreSQL version. Embeddings are deferred (ADR-0011), so the verification mainly confirms future compatibility and enabling the extension.

## Consequences
Commands in CLAUDE.md are added once the workspace is scaffolded (scaffolding not yet approved).
