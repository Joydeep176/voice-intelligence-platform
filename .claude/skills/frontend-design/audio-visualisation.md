# Audio waveform and speaker timeline

## Constraints
- **Never download or decode a whole long recording in the browser to draw a waveform.** Recordings can exceed two hours.
- Server-side waveform peaks (a precomputed artefact plus an endpoint) are **OD-39, Proposed and not approved**. Until it is decided, do not assume a peaks API exists. Use the time-ranged APIs that do exist (segments, speakers, diagnostics, uncertainties) and the streamed playback URL.
- The rendering library is OD-35 (Open). Do not add one without approval. A plain `<canvas>` renderer needs no dependency.

## Structure
Separate, aligned horizontal tracks sharing one time axis:
1. Playhead and time ruler (tabular mm:ss / h:mm:ss)
2. Waveform (only when OD-39 or an approved alternative provides data)
3. Speaker lanes: turns coloured by `speaker_key` and labelled with the display name (the machine ID stays visible on hover or details)
4. **Audio diagnostics track**: flags from the Audio Quality Agent (noise, clipping, distortion, dropout, silence, low level), labelled "Audio quality"
5. **Transcription uncertainty track**: low confidence, inaudible, overlapping speech, uncertain language or speaker, labelled "Transcription uncertainty"

Tracks 4 and 5 are never merged, never share a legend, and use different token families (FR-9.3).

## Behaviour
- Virtualise by time window: fetch and render only the visible range plus a margin (`fromMs`/`toMs`). Zoom changes the window.
- Render on canvas for dense data. Keep DOM nodes for interactive, focusable markers only.
- Two-way sync: clicking a track or transcript line seeks the player; playback highlights the current segment and scrolls the transcript only when the user hasn't scrolled away.
- Language and script: transcript text renders in its original script. Transliteration/translation views are separate, labelled representations (ADR-0007).
- Corrections: the UI shows which transcript version is displayed. Edits create a new version and never overwrite provider text.
