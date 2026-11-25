# Phase 2B real-stack end-to-end tests (WS9a)

`pnpm test:phase2b:e2e` (needs Docker running, `pnpm infra:up`, and `pnpm build` so `apps/*/dist` and `packages/*/dist` exist).

Self-contained Node script with `node:assert` (no new dependencies). It starts the real audio container (Compose project
`vip-p2b-e2e`, hardened profile), the real API and the real orchestrator, and drives everything over HTTP.

Isolation: database `TEST_DATABASE_URL` only (refuses names not ending `_test`; it is dropped and re-migrated), Redis DB 14
(flushed), throwaway storage under the scratch directory (`P2B_SCRATCH` to override), API on port 3917. The API and orchestrator
are started with an explicit minimal environment (not inheriting `.env`). Tokens and secrets are generated in memory and never printed or written.
Fixtures are synthetic (FFmpeg lavfi inside the audio image).

Teardown removes the audio container and its network and stops API/orchestrator; postgres and redis are left running.
