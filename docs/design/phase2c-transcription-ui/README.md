# Phase 2C C2 · transcript, speakers and run progress UI

Recording detail page, "Transcript" card (`apps/web/src/components/transcription/**`). Reuses the
processing card's `Pill` and `ProgressBar`; the API module loads with the lazy route chunk.

- **Run id.** The recording's `latestRun.id` (the `created` run made at upload); starting returns the run to follow. `GET /runs/{id}` is the source of status.
- **States.** Not started, Queued, Running (per stage, persisted fraction or indeterminate), Cancelling, Completed, Failed (code to plain text, Retry while `retryCount < maxRetries`), Cancelled. Scope is stated plainly. Window source note shown.
- **Start** is offered only when the audio processing card reports `completed` (via its optional `onStateChange`); a 409/503 is explained in plain language.
- **Polling** every 2 s only while queued/running/cancelling, paused while the tab is hidden.
- **Fake-provider banner**: non-dismissible, shown whenever any provider is `fake`; the transcript gets a dashed border.
- **Transcript.** Keyset-paged (100 per page, "Load more"), time-ordered, mm:ss / h:mm:ss, speaker display name else key, language tag, `lang` per segment (`hi`, `en`, none for mixed), uncertainty markers with text, confidence only when non-null. Version selector only with more than one version.
- **Speakers.** Inline rename (PATCH, list updates only after success, machine key stays visible, 422 and 409 messages, focus returns to the Rename button).
- **Accessibility.** Polite live region for state changes and renames, keyboard operable, reduced-motion safe animation, wraps at phone width, no verdict or quality language.
- **Not done.** Clicking a timestamp does not seek: `RecordingPlayback` keeps its audio element private and exposes no seek hook (a change outside the C2 files).
