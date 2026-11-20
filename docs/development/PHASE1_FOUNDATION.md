# Phase 1: Platform foundation

Status: **Implemented foundation; all required acceptance checks passed on 2026-11-20 (§8).** Formal Phase 1 closure is the user's decision.
Decisions made for Phase 1: ADR-0023 (FastAPI, provisional), ADR-0024 (lucide-react), ADR-0025 (`created` run status).

## 1. What exists

| Area | Implemented | Not implemented (by design) |
|---|---|---|
| Monorepo | pnpm 12 workspace, Turborepo, shared TS/ESLint presets (`packages/config`), Prettier, uv project for `services/audio` | CI pipeline (OD-17) |
| Contracts | `packages/contracts`: zod schemas for health, recordings, upload sessions, run status, Problem Details errors, error codes, queue payloads, audio-service API | Pipeline, transcript, report contracts |
| Database | `packages/db`: Drizzle schema + 2 migrations: `workspaces`, `recordings`, `upload_sessions`, `consent_attestations`, `pipeline_runs`, `audit_events`; pgvector enabled; dev seed | Every other DATABASE_DESIGN table; `workspace_members` (OD-27); RLS; immutability triggers (*Proposed*) |
| API (`apps/api`) | `/api/v1` prefix, config validation, JSON logs with request IDs, Problem Details errors, zod validation, CORS allow-list, 64 KB JSON limit, health (`/health`, `/health/live`, `/health/ready`), workspace guard (dev principal), recordings upload workflow, run status read, audit events, `StorageService` (local) | Authentication/authorisation (OD-08b, OD-27); runs start/cancel/retry; SSE (OD-16); deletion; signed playback URLs; S3 storage; rate limiting |
| Queue | BullMQ producer in the API, `apps/orchestrator` worker for the **foundation-check** queue only, bounded attempts/backoff/concurrency/stalled settings, graceful shutdown | Pipeline queues (LLD §5), LangGraph, agents |
| Audio service | FastAPI (provisional) app: settings, JSON logs, `/health/live`, `/health/ready`, `POST /v1/handshake`, safe errors, body-size limit, Dockerfile | Task API (`/v1/tasks`), probe, preprocessing, VAD, measurements, diarization |
| Web (`apps/web`) | App shell, sidebar + mobile sheet, workspace context, dashboard (live data + live system status), recording library with pagination, chunked upload with consent/progress/cancel/resume, recording detail, processing status, timeline structure, toasts, light/dark themes, loading/empty/error states | Transcript workspace, waveform data (OD-39), charts (OD-36), virtualisation (OD-37), fonts (OD-38), Motion (OD-33), 3D (OD-34) |

**No mock data is shown as real.** The web app only displays data returned by the API. Pipeline steps
after upload are shown as "Not available yet"; a run created at upload is shown as "Not started".
The foundation-check job only validates its payload and returns an acknowledgement; it does not
process audio.

## 2. Service boundaries

```
Browser ──/api (Vite proxy)──▶ apps/api (NestJS) ──▶ PostgreSQL (Drizzle)
                                   │  ├──▶ StorageService (local filesystem, S3-ready interface)
                                   │  ├──▶ Redis/BullMQ: produces foundation-check jobs
                                   │  └──HTTP──▶ services/audio (health + handshake only)
apps/orchestrator (NestJS standalone) ◀── BullMQ: consumes foundation-check jobs
```

- **API**: HTTP, validation, workspace scoping, persistence, storage, job production. Controllers contain no business logic (services and repositories do).
- **Orchestrator**: owns BullMQ consumers (ADR-0002). In later phases it hosts LangGraph and the seven agents.
- **Audio service**: deterministic, internal, no DB/Redis access (enforced by `tests/test_architecture.py`). Only its `api` package imports FastAPI (ADR-0023).
- **Contracts**: the single source of request/response types for web, API, orchestrator and (mirrored) Python.

## 3. Upload data flow

1. `POST /workspaces/{ws}/recordings` with `{ filename, mimeType, sizeBytes, consent }`. Consent is checked first (`422 CONSENT_REQUIRED`), then the body against the contract, then size (`413`). Creates `recordings` (`uploading`), `consent_attestations`, `upload_sessions` and an audit event in one transaction.
2. `PUT .../upload/parts/{n}` with `application/octet-stream`. The body is streamed to a temporary file, hashed while streaming, size-capped at the expected part size, and renamed into place. Nothing is buffered whole in memory. The part is recorded in `parts_received`.
3. `GET .../upload` lists received parts (resume).
4. `POST .../upload/complete`: all parts present → parts are concatenated (streamed) into `recordings/<ws>/<id>/original`, size and SHA-256 recorded, the file signature is checked against the declared type, then in one transaction: recording `uploaded`, session `completed`, a `pipeline_runs` row with status `created` (ADR-0025), audit event. Parts are deleted afterwards. A signature mismatch marks the recording `invalid`, aborts the session and removes all stored bytes.
5. `GET .../recordings`, `GET .../recordings/{id}` (with latest run), `GET .../runs/{runId}`.

Storage keys are built from UUIDs only (`[a-z0-9-]` segments) and resolved inside the storage root; filenames are metadata only. Storage URIs are never returned by the API.

## 4. Python contract maintenance

- The zod schemas in `packages/contracts/src/audio-service.ts` are authoritative. `services/audio/src/audio_service/contracts.py` mirrors them as Pydantic models (`extra="forbid"`).
- Shared JSON fixtures in `packages/contracts/fixtures/audio-service/` are validated by **both** Vitest (`contracts.test.ts`) and Pytest (`tests/test_contracts.py`). Pytest also asserts the contract version constant matches the TypeScript one.
- At runtime the Node client validates every response with zod and sends `contractVersion`; the service rejects unknown versions with `422 CONTRACT_VERSION_MISMATCH`.
- Change both sides and the fixtures in the same change.

## 5. Assumptions recorded

- **Authentication** (OD-08b) and **roles/isolation** (OD-27) are Open. `AUTH_MODE=dev` maps every request to the principal `dev-local`, a member of `DEV_WORKSPACE_ID` only; other workspace IDs return 404. The API refuses to start with `NODE_ENV=production`.
- **Limits** (OD-10) are Open: max size 2 GiB, part size 8 MiB, session TTL 24 h are configurable development defaults, not decisions.
- **Accepted MIME types** are an interim allow-list in `packages/contracts`. Validation in Phase 1 is shallow (declared type + file signature). Deep validation (codec, duration, integrity, FR-1.3) is the audio service `probe` task in a later phase, so `durationMs` stays `null`.
- **Consent statement** `dev-2026-11` is a development statement only; production wording and legal basis are OD-09b.
- **Observability** (OD-15) is Open: structured JSON logs only, no tracing.
- **Progress transport** (OD-16) is Proposed: the web app polls (detail page every 10 s, health every 30 s).
- **shadcn/ui baseline packages**: `cn`, `class-variance-authority` and `tw-animate-css` are generated by the shadcn CLI as part of shadcn/ui and are treated as part of the approved shadcn/ui stack. The `nova` preset's Geist font package was removed (OD-38); a system font stack with Devanagari-capable faces is used.
- **Routing**: a ~60-line history router in `apps/web/src/lib/router.tsx` instead of a routing library (none is approved).

## 6. Known limitations

- Single development principal and workspace; no login, no membership management.
- Local filesystem storage only; no S3 implementation, no signed playback URLs, so no audio player yet.
- Expired upload sessions are marked lazily on access; orphaned parts are not swept.
- `complete` concatenates parts synchronously in the request. Fine for development sizes; large recordings will need the S3 multipart path or a background job.
- No rate limiting (`429`) and no request-level authentication on the audio service (OD-23b; internal network only).
- No deletion workflow (SEC-6) and no audit read endpoint.
- The foundation-check queue is a boundary test only.
- Starlette prints a deprecation warning recommending `httpx2` for its test client; `httpx` is kept until that package has been reviewed.

## 7. Security and privacy limitations

Not production-ready. Missing before any production use: identity provider and authorisation (OD-08b, OD-27), service-to-service auth (OD-23b), encryption at rest/in transit configuration (SEC-4), retention and deletion (SEC-5/6, OD-09b), rate limiting, the production data policy (OD-09b) and secret management (AWS). Implemented foundations: input validation on every route, safe Problem Details errors with no content echo, content-free logs, CORS allow-list, body-size limits, streaming uploads with size caps, ID-only storage keys with path containment, atomic writes, append-only audit inserts, consent attestation, workspace-scoped queries with 404 for foreign resources.

## 8. Acceptance status

Verified on 2026-11-20 on macOS (Apple Silicon) with Docker Engine 29.9.3 and Compose v5.7.0,
following §2 and §5 of `SETUP.md`. Results below are from actual runs against the final working tree
unless marked otherwise.

**Infrastructure.** `pnpm infra:up` started `pgvector/pgvector:0.8.7-pg18-trixie` and
`redis:8.8.4-alpine`, both healthy and bound to 127.0.0.1. Databases `vip` and `vip_test` exist,
the `vector` extension (0.8.7) is enabled, `pnpm db:migrate` applied both migrations (6 tables) and
`pnpm db:seed` created the development workspace. Redis answers `PING` with
`maxmemory-policy noeviction`.

| Check | Command | Result |
|---|---|---|
| Unit tests | `pnpm test` | 82 passed, 0 failed, 0 skipped (contracts 15, db 4, api 44, orchestrator 3, web 16) |
| Integration tests | `pnpm test:integration` (with `pnpm audio:dev`) | 22 passed, 0 failed, 0 skipped (db 7, api 11, orchestrator 4) |
| Live queue check | `pnpm --filter @vip/api run foundation-check` with the orchestrator running | Passed: job round-tripped, `processedBy: orchestrator` (run before the e2e locator correction; that change touches no code the check uses) |
| End-to-end | `pnpm test:e2e` | 5 passed, 0 failed, 1 skipped by design (dark-mode capture runs on desktop only) |
| Python tests | `pnpm audio:test` | 17 passed, 0 failed, 0 skipped (1 Starlette deprecation warning, §6) |
| Lint, types, format | `pnpm lint` · `pnpm typecheck` · `pnpm format:check` · `pnpm audio:lint` | All passed |
| Build | `pnpm build` | 5 of 5 tasks succeeded |

End-to-end screenshots (desktop 01–06, mobile 01–05) are written to
`apps/web/test-results/screenshots/` (git-ignored).

**E2E correction.** The first e2e run failed the upload workflow on both projects: two text
locators in `apps/web/e2e/upload-workflow.spec.ts` matched more than one element (the "Uploaded"
status badge and the "Uploaded" date label; the "Not yet determined" duration value and the
timeline's "Duration not yet determined"). The locators were narrowed to the intended elements with
equally strict assertions. No application code or UI copy changed.

**Not executed.** The optional containerised audio service (`--profile audio`).

**Remaining non-blocking issues.**
- On mobile, the "Upload complete" toast overlaps the Timeline card on the recording detail page.
- Each e2e run adds two synthetic recordings to the development database and `.local-storage/`.
- `getByText('Not started')` in the e2e test is a substring match and could become ambiguous if
  similar text is added.
- The audio-service client builds the handshake request body without validating it against the
  `HandshakeRequest` schema (the service validates it; responses are validated client-side).
