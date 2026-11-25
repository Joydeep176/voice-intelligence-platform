# Phase 2B WS8 · Audio processing card

Status: implemented, awaiting review. Scope: the "Audio processing" card on the recording detail page
(`apps/web/src/components/processing/`), consuming `GET/POST /recordings/{id}/processing[/cancel]`
(API §3a, `packages/contracts/src/processing.ts`).

## Behaviour

- **Status badge**: Not started, Validating, Queued, Processing (with stage: probing, decoding, measuring,
  segmenting, writing), Completed, Failed, Cancelled; "Cancelling…" while `cancelRequested`; a second
  "No update received" badge when `progress.updatedAt` is older than 60 s while processing.
- **Progress** comes only from persisted `progress.fraction`. Unknown means an indeterminate bar with no
  percentage and no `aria-valuenow`.
- **Actions**: Start (not started, valid recording), Retry (failed or cancelled while `attempt < maxRetries`,
  remaining attempts shown), Cancel (queued or processing). Disabled while a request is in flight; 409 and
  503 are shown as fixed plain-language messages (codes only, never server text or JSON).
- **Polling** every 2 s only while validating, queued or processing; paused while the tab is hidden and
  refreshed immediately on return. A failed refresh keeps the last state and says so.
- **Completed** shows processed duration and format, timeline mapping with an honest explanation, decode
  class, VAD status, segment count and the whole-recording measurements as number + unit + kind
  (measured / derived / estimate). Unavailable measurements show their reason. No verdicts, scores or
  good/bad colours (ADR-0019); null values render as an em dash or "not available".
- **Accessibility**: polite live region (state changes only), focus moves to the details region after a
  successful action and to the inline error after a failed one, `motion-safe`/`motion-reduce` classes,
  responsive tables (horizontal scroll inside the card at phone width).

## Tests

- Vitest (`processing-card.test.tsx`): every state, determinate vs indeterminate progress, stale warning,
  polling start/stop/pause (fake timers), actions (202, 200, 409, 503), retry hidden when exhausted,
  no verdict words, focus.
- Playwright (`e2e/processing.spec.ts`, fully mocked network, no API or database needed): start to
  completed flow, plus axe (serious/critical gate) for nine states in both themes on desktop and mobile.
  Axe runs here rather than in Vitest because the repository has no jsdom axe dependency and none may be added.

## Bundle

The card, its API calls and the contract schemas sit in the lazy `recording-detail` route chunk (9.6 KB gzip).
The render-critical budget for `/recordings` was already over by 0.3 KB before this change (175.3 KB vs 175.0 KB,
from earlier uncommitted contract changes); this work adds 0.1 KB (175.4 KB). Radix Progress is not used, to keep
Radix out of the shared chunk.
