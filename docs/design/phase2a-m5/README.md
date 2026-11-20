# Phase 2A · M5: recording detail workspace and signed playback

Status: **Implemented 2026-11-20; awaiting review.**

- Decision: ADR-0033 "Signed local playback URLs" (Accepted; HLD §10 OD-45).
- Unchanged: M2 dashboard, M3 library and M4 upload. No transcript functionality was added; none exists yet.

## 1. Backend: signed local playback (ADR-0033)

| Endpoint | Behaviour |
| --- | --- |
| `GET /api/v1/workspaces/{ws}/recordings/{id}/audio` | Behind `WorkspaceAccessGuard`, with a workspace-scoped lookup (404). Status must be `uploaded`/`valid` (else 409 `INVALID_STATE_TRANSITION`). Returns `200 { url, expiresAt }` with `Cache-Control: no-store`. Each issuance writes one append-only `recording.playback_url_issued` audit row; if the write fails, no URL is issued. |
| `GET /api/v1/media/recordings/{token}` | The HMAC-SHA256 token is verified in constant time, then ownership, status, storage-URI integrity and MIME type are re-checked. Range: 200 / 206 / 416. Six security headers. Any failure is a uniform 404. Range requests are not audited. |

- Storage: `StorageService` gains `statObject` and `openReadStream(key, range?)`, both through the existing key validation and root containment.
- Config:
  - `MEDIA_URL_SIGNING_SECRET` is required, at least 32 characters, with no fallback; the `change-me` placeholder is rejected.
  - `MEDIA_URL_TTL_SECONDS` defaults to 300 (30–3600).
  - The local `.env` value was generated with OpenSSL and never displayed. Tests use a separate test-only value.

## 2. Frontend: recording detail workspace

- **Header:** back link, breadcrumb (Recordings › filename), the filename as the only `h1`, and the upload-status badge.
- **Audio player (real playback):**
  - a native `<audio preload="metadata">` with play/pause;
  - a seek slider (keyboard arrows, Home, End, `aria-valuetext`);
  - current time / duration, with duration read from the file and labelled as such while the stored duration is unknown;
  - loading, not-playable and error states, with one automatic URL re-issue for an expired URL and then "Playback unavailable" with a "Try again" button.
- **URL issuance:** **one playback URL per page view**, never re-issued by the 10 s refresh (verified).
- **Timeline:** a playhead at the current position. Speaker, audio-quality and uncertainty lanes honestly say "later phase". On mobile, labels sit above full-width tracks.
- **Transcript:** an honest unavailable state. No endpoint, no placeholder data.
- **Separate channels:** "Audio quality" and "Transcription uncertainty" stay separate (FR-9.3).
- **Side panel:** processing status (unchanged behaviour) and "Recording details" (format, size, duration, upload time, SHA-256, ID).
- **Bundle:** the playback URL is fetched through a route-local helper (`components/recording/playback-url.ts`), not the shared `api.ts`.

## 3. Verification

| Area | Result |
| --- | --- |
| API unit tests (Jest) | 115 passed: token signing and verification (tampered, wrong secret, expired, malformed), range parsing, storage stat and ranged read, config rules, token-free request logging |
| API integration tests (test database) | 12 passed: 409 while uploading; issue then 200, 206, 416; 404 for tampered and garbage tokens; one audit row per issuance; no token in audit rows |
| Contracts (Vitest) | 17 passed |
| Web unit tests (Vitest) | 100 passed, unchanged |
| Typecheck, lint, Prettier (changed files), build, bundle check | Passed |
| Live API (dev database) | Issue `no-store`; full GET 200 with all security headers; `bytes=0-99` 206 with 100 bytes; suffix range 206; out-of-range 416 `bytes */size`; tampered and garbage tokens 404 with identical bodies; other workspace and unknown recording 404 |
| Live expiry | The token streamed (206) while valid, and returned 404 after its expiry (checked 11 s after) |
| Live audit | 1 issuance → +1 `recording.playback_url_issued` row; 3 range requests → +0 |
| Token redaction | 0 occurrences of a live token in API log output; media requests are logged as the route pattern `media/recordings/:token` |
| Real browser (production build, live API, synthetic WAV) | Duration 20 s from the file. Play advanced playback. Pause worked. Keyboard seek reached 18 s ("0:18 of 0:20"). Media requests used Range (206). One URL issued per page view, even across a 10 s refresh. The file was fully buffered by the first range fetch, so seeking did not need a new request; Range seeking is proven by the live API checks above |
| Accessibility (axe, desktop, tablet and mobile, light and dark) | 0 violations of any impact. `color-contrast` is "needs review" only, for text over gradients |
| Responsive | 0 px horizontal overflow on every viewport |

E2E specs were not run, to avoid creating recordings. Consolidated testing is scheduled for the phase-level cycle (§7).

## 4. Bundle budgets (gzip; combined = render-critical + deferred Motion)

| Route | Before M5 | After M5 | Limit |
| --- | --- | --- | --- |
| recording-detail | 167.4 / 185.7 | **169.9 / 188.2** | 175 / 190 |
| upload | 171.0 / 189.3 | 171.1 / 189.4 | 175 / 190 |
| dashboard | 171.3 / 189.6 | 171.3 / 189.6 | 175 / 190 |
| recordings | 169.5 / 187.8 | 169.5 / 187.8 | 175 / 190 |

The detail route chunk is 4.7 KB. The +0.1 KB on upload is most likely the shared `PlaybackUrl` contract schema. Headroom is now 0.4–1.8 KB across routes.

## 5. Screenshots (`screenshots/`)

- `desktop-dark-recording-detail.png`
- `desktop-light-recording-detail.png`
- `tablet-dark-recording-detail.png`
- `mobile-dark-recording-detail.png`
- `mobile-light-recording-detail.png`

All show the live player at 0:08 of 0:20. Raw results are in `verify-results.json`.

## 6. Limitations and outstanding dependencies

- **Transcript:** no persistence, contract or endpoint exists, so the workspace shows an honest unavailable state. Transcript infrastructure is a future dependency of the pipeline phases.
- **Stored duration:** still null until the audio-service probe exists. The player shows the file's duration, labelled as such.
- **Production:**
  - authentication (OD-08b) and authorisation (OD-27): issuance relies on the development principal;
  - rate limiting;
  - an S3 implementation of the new storage methods, or presigned GETs;
  - secret management and rotation.
- **Bearer tokens:** revoking access takes effect within one URL lifetime (5 min).
- **Review notes for the phase-level Opus security review:**
  - a storage error mid-stream ends the response without a log line;
  - base64url decoding of the signature is lenient, which is harmless because the HMAC covers the exact payload string;
  - statting the file and then opening the stream is not atomic, which is acceptable because originals are immutable.

## 7. Next: consolidated Phase 2A testing and review (scheduled, not started)

Per the user's phase-level policy, this starts **only after the user declares Phase 2A implementation complete**. It must cover:
- the deferred M3 tests;
- M4 upload states, including resume-confirmation cases;
- M5 playback, including expiry and refresh in a real browser, with E2E kept minimal so few synthetic recordings are created;
- a full axe gate;
- the bundle checks.

Then the Opus architecture and security reviews follow, with priority on the ADR-0033 playback code (the `[opus-review-follows]` tagged work).
