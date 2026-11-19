---
paths:
  - "packages/**"
---

# Shared packages rules

- `packages/contracts`: zod schemas are the single definition of API DTOs, job payloads, the report model and the audio-service API. Python models in `services/audio` must mirror audio-service schemas; change both together.
- `packages/db`: Drizzle schema and migrations (see the `database` rule).
- Tests: Vitest.
