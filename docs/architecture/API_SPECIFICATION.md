# API Specification

Status: **Partly implemented.** Every endpoint below carries an implementation status: **Implemented**, **Partially implemented** (with what is missing) or **Not implemented (designed only)**. Implemented: §2 `POST /recordings`, `GET /recordings`, `GET /recordings/{id}`, `GET /recordings/{id}/upload`, `PUT /recordings/{id}/upload/parts/{n}`, `POST /recordings/{id}/upload/complete`, `GET /recordings/{id}/audio`; §2.1 `GET /api/v1/media/recordings/{token}`; §8 health (`/api/v1/health`, `/live`, `/ready`). §3a audio processing (Phase 2B) **Implemented**. Partially implemented (Phase 2C, interim D-2C-01..03; see each section for what is missing): §3 runs (`POST /recordings/{id}/runs`, `GET /runs/{runId}`, cancel, retry) and §5 transcript and speakers. Everything else is designed only. Phase 2B and Phase 2C are not yet accepted by the user. Authentication is a development principal only (OD-08b). Details and limitations: `docs/development/PHASE1_FOUNDATION.md`.

REST/JSON served by `apps/api`. An OpenAPI document will be generated from the controllers once they exist. Route shapes are *Proposed* unless they implement an approved requirement (SRS IDs cited).

## 1. Conventions

- Base path: `/api/v1/workspaces/{workspaceId}`. Every route below is relative to it (SEC-2). Every request needs an authenticated principal that is a member of the workspace (SEC-3; IdP deferred, OD-08b). Resources from another workspace return `404`.
- IDs are UUIDs; times are ISO 8601 UTC; audio offsets are integer ms.
- Cursor pagination: `?limit=&cursor=` → `{ items, nextCursor }`.
- Errors: RFC 9457 Problem Details with a stable `code`. Errors never echo transcript or audio content.
- Schemas are zod schemas in `packages/contracts`.
- While `AUTH_MODE=dev`, every request (health and media included) whose `Host` hostname is not loopback (`localhost`, `127.0.0.1`, `::1`) gets `403` with problem code `HOST_NOT_ALLOWED`. This is a DNS-rebinding defence for the unauthenticated development API.
- Recording filenames are metadata only: control (C0, DEL, C1), bidirectional and path-separator characters are rejected with a validation error.
- Security-relevant calls emit audit events (SEC-8).

## 2. Recordings, uploads and consent

Implementation status: **Implemented** for `POST /recordings`, `GET /recordings/{id}/upload`, `PUT .../upload/parts/{n}`, `POST .../upload/complete`, `GET /recordings`, `GET /recordings/{id}` and `GET /recordings/{id}/audio`. **Not implemented (designed only):** `POST .../upload/parts/{n}/url` (S3 is not implemented) and `DELETE /recordings/{id}`.

| Method | Path | Purpose | Req |
|---|---|---|---|
| POST | `/recordings` | Create recording + upload session. Body: `{ filename, mimeType, sizeBytes, consent: { statementVersion, attested: true } }`. Missing consent → `422 CONSENT_REQUIRED` | FR-1.1, SEC-1 |
| GET | `/recordings/{id}/upload` | Upload session: strategy, part size, **parts received**, expiry (resume) | FR-1.2 |
| PUT | `/recordings/{id}/upload/parts/{n}` | Local chunk upload (dev) | FR-1.2 |
| POST | `/recordings/{id}/upload/parts/{n}/url` | Presigned S3 part URL (cloud; re-issuable on resume) | FR-1.2 |
| POST | `/recordings/{id}/upload/complete` | Finalise. Phase 1: concatenates parts, records SHA-256, checks the file signature against the declared type (shallow), sets `uploaded` and creates a run with status `created` (ADR-0025). Deep validation (FR-1.3) comes with the audio-service probe | FR-1.3 |
| GET | `/recordings` · `/recordings/{id}` | List / detail (status, validation, latest run) | — |
| GET | `/recordings/{id}/audio` | Short-lived signed playback URL (audited), ADR-0033. `200 { url, expiresAt }`: `url` is a same-origin relative path to the media route below, valid for `MEDIA_URL_TTL_SECONDS` (default 300). `Cache-Control: no-store`. Unknown or other-workspace recording → `404`. Status not `uploaded`/`valid` → `409 INVALID_STATE_TRANSITION`. Each issuance writes `recording.playback_url_issued`; if the audit write fails, no URL is issued | SEC-8 |
| DELETE | `/recordings/{id}` | `202`; async deletion across all stores | SEC-6 |

### 2.1 Media (outside the workspace prefix; ADR-0033)

Implementation status: **Implemented** (development storage only; see Outstanding).

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/api/v1/media/recordings/{token}` | Streams a recording's original audio. The HMAC-signed `token` (recording, workspace, expiry) is the capability; the browser's `<audio>` element cannot send auth headers.<br>• **Checks per request:** ownership and playable status are re-checked on every request. Any failure is a uniform `404` (malformed, bad signature, expired, missing, wrong workspace, not playable).<br>• **Range:** single `Range` → `206` + `Content-Range`; none → `200` + `Accept-Ranges: bytes`; unsatisfiable → `416` + `Content-Range: bytes */size`; multi-range → `200` full.<br>• **Headers:** `Content-Type` from the validated stored MIME type, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Disposition: inline` (no filename), `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`.<br>• **Exposure and audit:** no storage paths or credentials are exposed, and range requests are not audited individually.<br>• **Outstanding:** production authentication (OD-08b), authorisation (OD-27), rate limiting, and S3 (presigned GET) for the cloud deployment | SEC-2, SEC-8 |

## 3. Runs

Implementation status: **Partially implemented (Phase 2C, interim D-2C-01..03).** Implemented for transcription runs, workspace scoped like every route (`/workspaces/{workspaceId}/...`; another workspace, an unknown or a malformed ID is `404`):

- `POST /recordings/{id}/runs` → `202` with the run snapshot. Submits the recording's existing `created` run (the one recorded at upload, ADR-0025), else creates one. Preconditions: recording `valid` and a `succeeded` audio preprocessing, else `409 INVALID_STATE_TRANSITION` (nothing is written). The run is linked to the preprocessing version, moves `created → queued`, a `run.requested` audit event is written and the `run-transcription` job is enqueued (queue unreachable: `503 DEPENDENCY_UNAVAILABLE`, the row stays `queued` and the orchestrator's sweeper recovers it). Idempotent: while the recording has a `queued`, `running` or `cancelling` run, that run is returned (`202`) and no second run or job is made; concurrent requests give one run. Body (optional, strict): `{ languageHints?: ("en"|"hi")[] }`; `reportLanguage` and `sourceTranscriptVersionId` are **not implemented** and rejected with `422`.
- `GET /runs/{runId}` → `RunSnapshot` (a superset of the previous `ProcessingStatus`, so existing consumers are unaffected): `id`, `recordingId`, `status`, `currentStage`, `error {code,node}`, `startedAt`, `completedAt`, `createdAt`, `updatedAt`, plus `preprocessingId`, `scope` (the stages this run executes: `transcription`, `diarization`; `completed` means the scoped stages completed, never the full pipeline), `stages[] { node, status (pending|running|completed|failed|cancelled), attempt, progress { fraction, processedMs, updatedAt } | null, startedAt, finishedAt, error { code } | null }`, `providers { stt, diarization } | null` (each `{ id, model, fake }`; `fake: true` marks deterministic development output that is not a real transcription; the selected self-hosted providers report `whisper-cpp` / `sherpa-onnx` with `fake: false`; null until the run starts), `window { source (vad_segments|fixed_windows), windowMs, overlapMs, count } | null`, `retryCount`, `maxRetries`, `cancelRequested`, `transcriptAvailable`. `Cache-Control: no-store`. **Not implemented:** `hasLimitations`, cost total.
- `POST /runs/{runId}/cancel` → `202`. `queued` becomes `cancelled` at once (waiting job removed); `running` becomes `cancelling` with `cancel_requested_at` (the orchestrator stops between windows and finishes `cancelled`; completed raw outputs are kept; no transcript is stored); repeating while `cancelling` is accepted. `created` or terminal: `409`. Audited (`run.cancelled` / `run.cancel_requested`).
- `POST /runs/{runId}/retry` → `202`. Only `failed`/`cancelled` while `retry_count < RUN_MAX_RETRIES` (3, OD-10, ADR-0039), else `409`. Counts the retry, clears the error, re-enqueues; raw outputs stored by earlier attempts are reused, not re-requested. Audited (`run.retried`).

**Not implemented (designed only):** `GET /runs/{runId}/events` (polling the snapshot is the fallback, ADR-0018), `sourceTranscriptVersionId` runs (ADR-0020), cost ceilings. Run, retry and cancel events also come from the orchestrator (`run.completed`, `run.failed`, `run.cancelled`, `run.retried` by the sweeper) with actor `orchestrator`; audit metadata is IDs, counts and codes only.

| Method | Path | Purpose | Req |
|---|---|---|---|
| POST | `/recordings/{id}/runs` | Start. Body: `{ languageHints?: ("en"\|"hi")[], reportLanguage?: "en"\|"hi", sourceTranscriptVersionId?: uuid }` (default `en`) → `202`. With `sourceTranscriptVersionId`, a new traceable run starts from Context Intelligence using that version (ADR-0020; field *Proposed*, OD-26b) | FR-9.4, FR-12.4 |
| GET | `/runs/{runId}` | Status snapshot: per-stage status and progress, `hasLimitations`, cost total, error code | FR-11.1 |
| GET | `/runs/{runId}/events` | Progress stream (transport OD-16, *Proposed* SSE). Events: `stage.started`, `stage.progress`, `stage.completed`, `stage.failed`, `run.cancelling`, `run.cancelled`, `run.completed`, `run.needs_review`, `run.failed` | FR-11.1, ADR-0018 |
| POST | `/runs/{runId}/cancel` | `202`. `409` if already terminal | FR-11.2 |
| POST | `/runs/{runId}/retry` | `202`. `409` if not `failed`/`cancelled` or retry limit reached | FR-11.3 |

Research cannot be disabled per run (ADR-0009).

## 3a. Audio processing (Phase 2B; ADR-0014, ADR-0018, ADR-0025)

Implementation status: **Implemented** (backend). Workspace-scoped like every route: a recording in another workspace, a malformed ID or an unknown recording is `404`. These routes never touch `pipeline_runs`. `GET` is a database snapshot (polling fallback, ADR-0018; no SSE); `Cache-Control: no-store`. Limits shown (4 h, 8 channels, 192 kHz, 10 s blocks, retries 3) are the accepted OD-10 limits (ADR-0039).

Validation (probe) starts automatically after `upload/complete` for **new** uploads only (existing recordings are never backfilled): the recording goes `uploaded -> validating -> valid | invalid` (`validationError` holds the code). Preprocessing is started explicitly.

| Method | Path | Purpose |
|---|---|---|
| POST | `/recordings/{id}/processing` | Explicit start. `uploaded`: begins validation and then preprocessing (`202`). `validating`: `202`, nothing new. `valid`: builds the config (shared builder + the service's tool versions from `GET /v1/capabilities`), hashes it and upserts one version per (recording, config hash). A succeeded version for that hash is returned with `200` and no job. `failed`/`cancelled` is reset and re-queued while `attempt < PROCESSING_MAX_RETRIES`, else `409 INVALID_STATE_TRANSITION`. `invalid`, `uploading`, `deleting`: `409 INVALID_STATE_TRANSITION`. Audio service not configured, unreachable or unable to preprocess: `503 DEPENDENCY_UNAVAILABLE`, nothing written. Repeated or concurrent calls give one row and one job |
| POST | `/recordings/{id}/processing/cancel` | `202`. A `queued` version becomes `cancelled` at once (waiting job removed); a `running` one records `cancel_requested_at` and the orchestrator stops the task. Nothing active: `409` |
| GET | `/recordings/{id}/processing` | Snapshot `{ state, recording: { status, validationError }, probe, preprocessing }`. `state`: `not_started`, `validating`, `queued`, `processing`, `completed`, `failed`, `cancelled`. `probe`: `{ container, codec, sampleRateHz, channels, durationMs }`. `preprocessing`: `{ id, status, progress { stage, fraction, processedMs, updatedAt }, attempt, maxRetries, error { code, retryable }, cancelRequested, startedAt, finishedAt, configHash, canonical { durationMs, sha256 }, timeline { mappingStatus, mappingErrorBoundMs, decodeClass, decodedUntilMs, gapCount }, measurements, vad, segmentCount }`. Unknown values are `null`, never estimated |
| GET | `/recordings/{id}/processing/segments?fromMs&toMs&limit` | Segments of the latest succeeded version (`limit` 1 to 1000, default 100). Empty: preprocessing VAD stays `none` (ADR-0038; VAD is applied inside transcription windows): `{ preprocessingId, items[] }` |

DTOs: `ProcessingSnapshot`, `ProcessingSegmentList` in `packages/contracts/src/processing.ts`. Job payloads (IDs only): `AudioProbeJob`, `AudioPreprocessJob` in `jobs.ts`.

## 4. Audio diagnostics (separate from transcription uncertainty)

Implementation status: **Not implemented (designed only).**

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/audio-diagnostics` | Audio Quality Agent output for the run (verdict, flags, summary) plus the objective measurements it was based on | FR-3.1–3.3 |

## 5. Transcript

Implementation status: **Partially implemented (Phase 2C, interim).** Implemented: `GET .../transcript/versions`, `GET .../transcript`, `GET .../transcript/uncertainties`, `GET .../transcript/raw` (metadata only), `GET .../speakers`, `PATCH .../speakers/{speakerId}`. **Not implemented:** `POST .../transcript/versions` (correction versions) and `GET .../transcript/derivations` (no such routes: `404`). All are workspace scoped, `Cache-Control: no-store`, and never return storage URIs.

- `transcript/versions` → `{ items: [{ id, version, kind, baseVersionId, createdBy, note, createdAt, segmentCount }] }`; empty before a transcript exists.
- `transcript?version=&fromMs=&toMs=&limit=&cursor=` → `{ runId, transcriptId, version, kind, windowSource, providers, items: [{ id, speakerId, startMs, endMs, text, language (en|hi|mixed), codeSwitchSpans, confidence (null when the provider gave none), words }], nextCursor }`. Default version: latest. Segments overlapping `[fromMs, toMs)`, ordered by (`startMs`, `id`), keyset-paged by an opaque cursor; `limit` 1 to 1000 (default 200). No transcript yet or unknown `version`: `404`; invalid cursor or query: `422`.
- `transcript/uncertainties` takes the same query → `{ version, items: [{ id, segmentId, startMs, endMs, kind, score }], nextCursor }`. Generated kinds: `overlapping_speech` and `speaker_uncertain` (the fake provider reports no confidence, so no `low_confidence`, `inaudible` or `language_uncertain`).
- `transcript/raw` → `{ items: [{ id, kind (stt|diarization), provider, providerModel, scope, windowIndex, windowStartMs, windowEndMs, sha256, receivedAt, fake }] }`. **Signed URLs are not implemented**: the existing signed-URL pattern is recording playback only (ADR-0033) and does not apply cleanly to raw payloads, so only metadata is returned (the bytes are verifiable against `sha256` in storage). Because only metadata is returned, access is not audited.
- `speakers` → `{ items: [{ id, speakerKey, displayName, totalSpeechMs }] }`. `PATCH` body `{ displayName }` (1 to 80 characters, trimmed; any other field, including `speakerKey`, is `422`) → the updated speaker. Audited as `speaker.renamed` with IDs only (the name is not logged).

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

Implementation status: **Not implemented (designed only).**

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/topics` | Topics (inferred, with spans) | FR-6.1 |
| GET | `/runs/{runId}/entities` | Entities with mention spans | FR-6.1 |
| GET | `/runs/{runId}/claims` | Claims, verdicts, evidence links | FR-6.2, FR-8.1 |
| GET | `/runs/{runId}/sources` | Sources with metadata and retrieval type | FR-7.3 |
| GET | `/runs/{runId}/research-queries` | Queries exactly as sent externally | FR-7.2, SEC-7 |

## 7. Reports

Implementation status: **Not implemented (designed only).**

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/runs/{runId}/report?version=` | Structured report model for in-app HTML rendering (assertions with provenance and refs) | FR-9.1–9.5 |
| GET | `/runs/{runId}/report/qa` | QA reviews and issues | FR-10.2 |
| POST | `/runs/{runId}/report/exports` | `{ format: "pdf"\|"docx", version? }` → `202` (tooling OD-25) | FR-9.4 |
| GET | `/runs/{runId}/report/exports/{exportId}` | Status + signed download URL (audited) | FR-9.4 |

## 8. Audit and operations

Implementation status: health endpoints (`/api/v1/health`, `/live`, `/ready`) **Implemented**. `GET /audit-events` **Not implemented (designed only)**.

| Method | Path | Purpose | Req |
|---|---|---|---|
| GET | `/audit-events` | Workspace audit log, admin role (OD-27) | SEC-8 |
| GET | `/api/v1/health/live` · `/api/v1/health/ready` | Probes (unauthenticated; outside the workspace prefix). `ready` = Postgres and Redis reachable | — |
| GET | `/api/v1/health` | Aggregate health: `status` (`ok` \| `degraded` \| `down`), version, environment, and per-dependency status (`postgres`, `redis`, `audio-service`) with latency and a content-free reason code. `503` only when a required dependency (Postgres, Redis) is down. Added by the Phase 1 brief | — |

## 9. Status codes

`200` · `201` · `202` · `400` · `401` · `403` · `404` (also cross-workspace) · `409` invalid state transition · `413` · `422` validation / consent · `429` · `5xx`. `403 HOST_NOT_ALLOWED` applies in dev mode (§1).

## 10. Not in scope without approval

Semantic search, cross-recording queries, sharing outside the workspace, webhooks, public API keys, multi-user role management (OD-27).
