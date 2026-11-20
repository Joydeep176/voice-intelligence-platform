# Local development setup

Phase 1 foundation. Development uses **synthetic or explicitly consented audio only** (ADR-0004).
Nothing here is production-ready: there is no authentication (OD-08b, OD-27).

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 26.x (`.nvmrc`) | NestJS 12 on Jest needs Node ≥ 24.9 |
| pnpm | 12.x (`packageManager`) | The only JS package manager (ADR-0005). Do not use npm |
| uv | 0.13.x | Manages the Python 3.12 runtime for `services/audio` |
| Docker Desktop (or another Compose v2 runtime) | current | PostgreSQL + pgvector and Redis |

## 2. First-time setup

```sh
cp .env.example .env            # then replace every "change-me" value (never commit .env)
pnpm install                    # JS workspace (lockfile: pnpm-lock.yaml)
pnpm audio:sync                 # Python venv for services/audio (lockfile: services/audio/uv.lock)
(cd apps/web && pnpm exec playwright install chromium)   # browser for e2e tests
pnpm infra:up                   # postgres + redis, waits for health checks
pnpm build                      # builds packages (contracts, db) and apps
pnpm db:migrate                 # applies packages/db/drizzle/*.sql
pnpm db:seed                    # creates the development workspace only
```

The Postgres init script creates a second database, `<POSTGRES_DB>_test`, used by integration
tests. It runs only when the data volume is first created. If you created the volume before this
script existed, create it once: `docker compose -f infra/docker/compose.yaml --env-file .env exec postgres createdb -U vip vip_test`.

## 3. Running the platform

Run each in its own terminal (all read the repository-root `.env`):

| Component | Command | URL |
|---|---|---|
| Infrastructure | `pnpm infra:up` / `pnpm infra:down` | Postgres 127.0.0.1:5432, Redis 127.0.0.1:6379 |
| Audio service (Python) | `pnpm audio:dev` | http://127.0.0.1:8001 (`/health/live`, `/docs`) |
| API (NestJS) | `pnpm --filter @vip/api dev` | http://127.0.0.1:3000/api/v1/health |
| Orchestrator (worker) | `pnpm --filter @vip/orchestrator dev` | none (BullMQ consumer) |
| Web (Vite) | `pnpm --filter @vip/web dev` | http://localhost:5173 |

The web dev server proxies `/api` to the API, so the browser stays same-origin.
`pnpm dev` runs every JS app through Turborepo at once; the audio service runs separately.
Optionally run the audio service in Docker instead: `docker compose -f infra/docker/compose.yaml --env-file .env --profile audio up -d --build audio-service`.

**Queue check (foundation test, no audio processing):** with Redis and the orchestrator running,
`pnpm --filter @vip/api run foundation-check` enqueues one job and prints the worker's result.

## 4. Database migrations

- Schema: `packages/db/src/schema.ts`. Migrations: `packages/db/drizzle/` (committed).
- After changing the schema: `pnpm db:generate` (drizzle-kit, no DB needed), review the SQL, then `pnpm db:migrate`.
- Migrations are applied by the same code path the integration tests use (`runMigrations`), so they are reproducible from an empty database. Re-running them is a no-op.
- Update `docs/architecture/DATABASE_DESIGN.md` in the same change (database rule).

## 5. Tests, linting and type checks

| Scope | Command | Runner |
|---|---|---|
| All unit tests (JS) | `pnpm test` | Vitest (web, packages), Jest (api, orchestrator) |
| Integration (Postgres, Redis, audio service) | `pnpm test:integration` | needs `pnpm infra:up`, migrated test DB is reset automatically, and `pnpm audio:dev` for the audio-client test |
| End-to-end | `pnpm test:e2e` | Playwright; needs infra up, migrated and seeded DB (starts API and web itself) |
| Python | `pnpm audio:test` | Pytest |
| Lint + types (JS) | `pnpm lint` · `pnpm typecheck` | ESLint 10, TypeScript 6.0 |
| Lint + types (Python) | `pnpm audio:lint` | ruff, mypy (strict) |
| Formatting | `pnpm format:check` / `pnpm format` | Prettier |

Single test examples:
- Jest: `pnpm --filter @vip/api test -- src/storage/local-storage.service.spec.ts`
- Vitest: `pnpm --filter @vip/web test -- src/pages/upload.test.tsx`
- Pytest: `uv run --directory services/audio pytest tests/test_api.py::test_handshake_echoes_request_and_contract`
- Playwright: `pnpm --filter @vip/web test:e2e -- --project=desktop`

Integration tests refuse to reset any database whose name does not end in `_test`, and use Redis
logical DB 15, so development data is never touched.

## 6. Environment variables

All variables are listed in `.env.example`. Each service validates its own variables at start-up
and reports invalid **names** only (never values).

| Variable | Used by | Purpose / default |
|---|---|---|
| `NODE_ENV` | api, orchestrator, db CLI | `development` \| `test` \| `production`. The API refuses to start in production (no auth) |
| `LOG_LEVEL` | api, orchestrator | `info` |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Compose | Local database container |
| `DATABASE_URL` | api, db CLI | Development database |
| `TEST_DATABASE_URL` | integration tests | Must end in `_test` |
| `REDIS_PORT`, `REDIS_URL` | Compose, api, orchestrator | BullMQ only |
| `API_HOST`, `API_PORT` | api | `127.0.0.1`, `3000` |
| `API_CORS_ORIGINS` | api | Comma-separated origins, default `http://localhost:5173`. `*` is rejected |
| `AUTH_MODE` | api | Only `dev` exists (development principal). Not allowed with `NODE_ENV=production` |
| `DEV_WORKSPACE_ID` | api, db seed | The single development workspace |
| `STORAGE_DRIVER` | api | Only `local` is implemented |
| `STORAGE_LOCAL_ROOT` | api | `.local-storage` (repo-root relative, git-ignored, unreadable to Claude Code by settings) |
| `UPLOAD_MAX_BYTES` | api | 2 GiB: interim development default (OD-10 Open) |
| `UPLOAD_PART_SIZE_BYTES` | api | 8 MiB (min 1 KiB, max 64 MiB) |
| `UPLOAD_SESSION_TTL_MINUTES` | api | 1440 |
| `AUDIO_SERVICE_URL`, `AUDIO_SERVICE_TIMEOUT_MS` | api | `http://127.0.0.1:8001`, 3000 ms |
| `AUDIO_SERVICE_PORT` | Compose | 8001 |
| `AUDIO_SERVICE_ENV`, `AUDIO_SERVICE_LOG_LEVEL`, `AUDIO_SERVICE_HOST`, `AUDIO_SERVICE_MAX_REQUEST_BYTES` | audio service | Optional; defaults in `services/audio/src/audio_service/config.py` |
| `QUEUE_FOUNDATION_ATTEMPTS`, `QUEUE_FOUNDATION_BACKOFF_MS` | api (producer) | 3 attempts, exponential backoff from 1000 ms |
| `QUEUE_FOUNDATION_CONCURRENCY` | orchestrator | 2 |
| `QUEUE_STALLED_INTERVAL_MS`, `QUEUE_MAX_STALLED_COUNT`, `QUEUE_LOCK_DURATION_MS`, `SHUTDOWN_TIMEOUT_MS` | orchestrator | 30 s, 1, 30 s, 10 s |
| `VITE_DEV_WORKSPACE_ID` | web | Exposed to the browser (not a secret) |

## 7. Data hygiene

- Use synthetic audio (tests generate sine-tone WAVs in code) or audio every speaker explicitly consented to.
- Uploaded audio lives under `.local-storage/` (git-ignored). Delete it with `rm -rf .local-storage` when finished.
- Logs contain request IDs, routes, status codes, sizes and error codes only. Never paste recordings or transcripts into issues, logs or commits.
