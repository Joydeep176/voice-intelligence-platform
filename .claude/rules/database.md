---
paths:
  - "packages/db/**"
  - "**/drizzle/**"
  - "**/migrations/**"
  - "**/*.sql"
---

# Database rules

- Follow `docs/architecture/DATABASE_DESIGN.md`. Drizzle schema + Drizzle Kit migrations only (ADR-0005). Update the doc in the same change.
- Every tenant-owned table has `workspace_id`.
- Immutable tables (raw outputs, transcript versions/segments, audit events) get no update paths.
- No embedding tables until ADR-0011 is superseded.
- LangGraph checkpoint tables are library-managed.
