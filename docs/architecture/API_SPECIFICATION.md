# API Specification

Status: **Partly implemented (Phase 1).** Implemented: §2 `POST /recordings`, `GET /recordings/{id}/upload`, `PUT /recordings/{id}/upload/parts/{n}`, `POST /recordings/{id}/upload/complete`, `GET /recordings`, `GET /recordings/{id}`; §3 `GET /runs/{runId}`; §8 health probes plus `GET /api/v1/health` (aggregate, below). Authentication is a development principal only (OD-08b). Everything else is design. Details and limitations: `docs/development/PHASE1_FOUNDATION.md`.

REST/JSON served by `apps/api`. An OpenAPI document will be generated from the controllers once they exist. Route shapes are *Proposed* unless they implement an approved requirement (SRS IDs cited).

## 1. Conventions

- Base path: `/api/v1/workspaces/{workspaceId}`. Every route below is relative to it (SEC-2). Every request needs an authenticated principal that is a member of the workspace (SEC-3; IdP deferred, OD-08b). Resources from another workspace return `404`.
- IDs are UUIDs; times are ISO 8601 UTC; audio offsets are integer ms.
- Cursor pagination: `?limit=&cursor=` → `{ items, nextCursor }`.
- Errors: RFC 9457 Problem Details with a stable `code`. Errors never echo transcript or audio content.
- Schemas are zod schemas in `packages/contracts`.
- Security-relevant calls emit audit events (SEC-8).

## 2. Recordings, uploads and consent

| Method | Path | Purpose | Req |
|---|---|---|---|
| POST | `/recordings` | Create recording + upload session. Body: `{ filename, mimeType, sizeBytes, consent: { statementVersion, attested: true } }`. Missing consent → `422 CONSENT_REQUIRED` | FR-1.1, SEC-1 |
| GET | `/recordings/{id}/upload` | Upload session: strategy, part size, **parts received**, expiry (resume) | FR-1.2 |
| PUT | `/recordings/{id}/upload/parts/{n}` | Local chunk upload (dev) | FR-1.2 |
| POST | `/recordings/{id}/upload/parts/{n}/url` | Presigned S3 part URL (cloud; re-issuable on resume) | FR-1.2 |
| POST | `/recordings/{id}/upload/complete` | Finalise. Phase 1: concatenates parts, records SHA-256, checks the file signature against the declared type (shallow), sets `uploaded` and creates a run with status `created` (ADR-0025). Deep validation (FR-1.3) comes with the audio-service probe | FR-1.3 |
| GET | `/recordings` · `/recordings/{id}` | List / detail (status, validation, latest run) | — |
| GET | `/recordings/{id}/audio` | Short-lived signed playback URL (audited) | SEC-8 |
| DELETE | `/recordings/{id}` | `202`; async deletion across all stores | SEC-6 |

## 3. Runs

| Method | Path | Purpose | Req |
|---|---|---|---|
| POST | `/recordings/{id}/runs` | Start. Body: `{ languageHints?: ("en"\|"hi")[], reportLanguage?: "en"\|"hi", sourceTranscriptVersionId?: uuid }` (default `en`) → `202`. With `sourceTranscriptVersionId`, a new traceable run starts from Context Intelligence using that version (ADR-0020; field *Proposed*, OD-26b) | FR-9.4, FR-12.4 |
| GET | `/runs/{runId}` | Status snapshot: per-stage status and progress, `hasLimitations`, cost total, error code | FR-11.1 |
| GET | `/runs/{runId}/events` | Progress stream (transport OD-16, *Proposed* SSE). Events: `stage.started`, `stage.progress`, `stage.completed`, `stage.failed`, `run.cancelling`, `run.cancelled`, `run.completed`, `run.needs_review`, `run.failed` | FR-11.1, ADR-0018 |
| POST | `/runs/{runId}/cancel` | `202`. `409` if already terminal | FR-11.2 |
| POST | `/runs/{runId}/retry` | `202`. `409` if not `failed`/`cancelled` or retry limit reached | FR-11.3 |

Research cannot be disabled per run (ADR-0009).

## 4. Audio diagnostics (separate from transcription uncertainty)

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/audio-diagnostics` | Audio Quality Agent output for the run (verdict, flags, summary) plus the objective measurements it was based on | FR-3.1–3.3 |

## 5. Transcript

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/transcript/versions` | List versions (machine v1 + corrections) | FR-4.5, FR-12.1 |
| GET | `/runs/{runId}/transcript?version=&fromMs=&toMs=` | Segments by time range (default: latest version) | FR-11.4 |
| POST | `/runs/{runId}/transcript/versions` | Create correction version: `{ baseVersionId, edits: [{ segmentId, text?, speakerId? }], note? }` → `201` | FR-12.1 |
| GET | `/runs/{runId}/transcript/uncertainties?version=&fromMs=&toMs=` | Transcription uncertainty spans | FR-4.7 |
| GET | `/runs/{runId}/transcript/derivations?version=&kind=` | Transliteration/translation representations (generation and trigger: OD-24b) | FR-4.5 |
| GET | `/runs/{runId}/transcript/raw` | Raw provider output references (metadata + signed URLs; audited) | FR-4.4 |
| GET | `/runs/{runId}/speakers` | Speakers: `speakerKey`, `displayName` | FR-4.6 |
| PATCH | `/runs/{runId}/speakers/{speakerId}` | `{ displayName }`. `speakerKey` is immutable | FR-12.2 |

## 6. Analysis, research and validation

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/topics` | Topics (inferred, with spans) | FR-6.1 |
| GET | `/runs/{runId}/entities` | Entities with mention spans | FR-6.1 |
| GET | `/runs/{runId}/claims` | Claims, verdicts, evidence links | FR-6.2, FR-8.1 |
| GET | `/runs/{runId}/sources` | Sources with metadata and retrieval type | FR-7.3 |
| GET | `/runs/{runId}/research-queries` | Queries exactly as sent externally | FR-7.2, SEC-7 |

## 7. Reports

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/report?version=` | Structured report model for in-app HTML rendering (assertions with provenance and refs) | FR-9.1–9.5 |
| GET | `/runs/{runId}/report/qa` | QA reviews and issues | FR-10.2 |
| POST | `/runs/{runId}/report/exports` | `{ format: "pdf"\|"docx", version? }` → `202` (tooling OD-25) | FR-9.4 |
| GET | `/runs/{runId}/report/exports/{exportId}` | Status + signed download URL (audited) | FR-9.4 |

## 8. Audit and operations

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/audit-events` | Workspace audit log, admin role (OD-27) | SEC-8 |
| GET | `/api/v1/health/live` · `/api/v1/health/ready` | Probes (unauthenticated; outside the workspace prefix). `ready` = Postgres and Redis reachable | — |
| GET | `/api/v1/health` | Aggregate health: `status` (`ok` \| `degraded` \| `down`), version, environment, and per-dependency status (`postgres`, `redis`, `audio-service`) with latency and a content-free reason code. `503` only when a required dependency (Postgres, Redis) is down. Added by the Phase 1 brief | — |

## 9. Status codes

`200` · `201` · `202` · `400` · `401` · `403` · `404` (also cross-workspace) · `409` invalid state transition · `413` · `422` validation / consent · `429` · `5xx`.

## 10. Not in scope without approval

Semantic search, cross-recording queries, sharing outside the workspace, webhooks, public API keys, multi-user role management (OD-27).
