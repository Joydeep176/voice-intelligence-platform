# ADR-0033: Signed local playback URLs

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-45 (recording playback access; new)
- Affects: `apps/api` (recordings, new `playback` module, `storage`, config, audit), `packages/contracts`, `apps/web` (recording detail), `docs/architecture/API_SPECIFICATION.md`, `docs/architecture/LLD.md`, `.env.example`, `docs/development/SETUP.md`

## Context
Phase 2A M5 needs in-browser playback of a stored recording. The API spec defined
`GET /recordings/{id}/audio` as a "short-lived signed playback URL (audited)" (SEC-8), and the LLD gave
`StorageService` signed URLs, but neither was implemented.

An HTML `<audio>` element cannot send authentication headers, and seeking needs HTTP Range requests.
`StorageService` had no streaming or ranged read. Its key handling is safe: keys are built from IDs, match a
strict pattern and resolve inside the storage root.

## Options considered
1. **Proxy audio through the workspace route with header auth.** `<audio>` cannot attach headers, so this
   would need cookies or fetch-into-blob, which means no streaming seek and the whole file in memory.
2. **A signed, short-lived capability URL served by the API.** It works with native `<audio>` and Range,
   keeps storage hidden, and maps later to S3 presigned GETs.

## Decision
The user approved option 2 on 2026-11-20.

**1. Issue a playback URL:** `GET /api/v1/workspaces/{workspaceId}/recordings/{id}/audio`
- Access:
  - `WorkspaceAccessGuard` applies, then a per-workspace recording lookup. An unknown recording or another
    workspace gives 404.
  - The recording must be `uploaded` or `valid`. Otherwise the API returns 409 `INVALID_STATE_TRANSITION`.
- Response: `200 { url, expiresAt }`, where `url` is a same-origin relative path, with `Cache-Control: no-store`.
- Audit: each issuance writes an append-only `recording.playback_url_issued` event (IDs and expiry only).
  If the audit write fails, no URL is issued.

**2. Stream the audio:** `GET /api/v1/media/recordings/{token}`
- Route: outside the workspace prefix. The token is the capability.
- Token format: `base64url(payload).base64url(HMAC-SHA256(payload))`.
  - The payload holds a version, the recording ID, the workspace ID and the expiry.
  - The signing key is `MEDIA_URL_SIGNING_SECRET`.
  - Tokens are length-capped, parsed strictly and compared in constant time.
- Checks on every request:
  - the recording still exists in the token's workspace and is playable;
  - the key comes from `StorageKeys.original`, and `uriFor(key)` equals the stored `storageUri`;
  - the stored MIME type is in `SUPPORTED_AUDIO_MIME_TYPES`.
- **Any failure returns a uniform 404**: malformed, bad signature, expired, missing, wrong workspace or not playable.
- Range behaviour:
  - a single range gets 206 with `Content-Range`;
  - no Range header gets 200 with `Accept-Ranges: bytes`;
  - an unsatisfiable range gets 416 with `Content-Range: bytes */size`;
  - a multi-range request is served in full (200).
- Response headers:
  - `Content-Type` comes from the validated stored type;
  - `X-Content-Type-Options: nosniff`;
  - `Cache-Control: private, no-store`;
  - `Content-Disposition: inline` without a filename;
  - `Cross-Origin-Resource-Policy: same-origin`;
  - `Referrer-Policy: no-referrer`.
- Byte-range requests are **not** audited individually.

**3. Configuration**
- `MEDIA_URL_SIGNING_SECRET` is required, at least 32 characters, with no fallback. Its value is never logged.
- `MEDIA_URL_TTL_SECONDS` defaults to 300 and is validated between 30 and 3600.

**4. Storage**
- `StorageService` gains `statObject(key)` and `openReadStream(key, range?)`.
- Both go through the existing key validation and root containment.

**5. Logs and exposure**
- Logs never contain tokens. Request logs record route patterns only.
- No filesystem paths, storage URIs or credentials reach the browser.

## Consequences
- The API does not start without `MEDIA_URL_SIGNING_SECRET`. It is documented in `.env.example` (placeholder
  only) and `SETUP.md`. Automated tests use a separate test-only value.
- Revoking access takes effect within one URL lifetime, because tokens are bearer capabilities.
- Rotating the secret invalidates outstanding URLs, which is acceptable at a five-minute lifetime.
- Outstanding before production:
  - authentication (OD-08b) and workspace authorisation (OD-27): issuance currently relies on the development principal;
  - rate limiting;
  - an S3 implementation of the new storage methods, or S3 presigned GETs replacing the media route in the cloud deployment;
  - secret management and rotation.
