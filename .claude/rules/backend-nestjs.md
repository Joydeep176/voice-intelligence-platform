---
paths:
  - "apps/api/**"
  - "apps/orchestrator/**"
---

# NestJS backend rules

- Shared DTOs, job payloads, report model and audio-service API types come from `packages/contracts`. Do not redefine them.
- Node owns BullMQ (ADR-0002): `apps/api` produces jobs and listens to QueueEvents. All pipeline work runs in `apps/orchestrator`. HTTP handlers never do heavy processing.
- Every query and route is workspace-scoped (ADR-0003). Cross-workspace access → 404.
- Job payloads carry IDs only. Every queue has configured concurrency, attempts, backoff, timeout and stalled settings (ADR-0010).
- Storage only through `StorageService`. Configuration validated at startup. No hard-coded providers, model IDs or limits.
- Logs and errors contain IDs and codes only, never transcript text, prompts or secrets. Emit audit events for security-relevant actions.
- Tests: Jest.
