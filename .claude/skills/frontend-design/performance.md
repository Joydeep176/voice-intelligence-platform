# Performance and lazy loading

- Route-level code splitting with React `lazy` + `Suspense`. Heavy, optional views (3D, large visualisations, export previews) load only when opened.
- Long lists and transcripts: fetch by time range or cursor and render only what is visible. A virtualisation library is OD-37 (Open). Until approved, use windowed rendering built on the paginated APIs.
- Heavy client computation (for example layout of dense timeline data) runs off the main thread in a Web Worker.
- Never load whole transcripts, all sources or full audio up front. Use the paginated, time-ranged endpoints (API §5–6).
- Fonts (ADR-0028, self-hosted IBM Plex): use the official upstream files and their `unicode-range` splits, never modified or self-subset (the OFL reserves the "Plex" name); ship only the weights used, preload at most two files, and avoid layout shift.
- Images and icons: SVG or optimised assets with explicit sizes.
- Bundle budgets are enforced by `pnpm --filter @vip/web check:bundle` (limits and rationale: `docs/design/phase2a-m0-baseline/README.md` §5): render-critical, deferred Motion and combined route JavaScript are separate budgets. Deferred code must never be needed to render or show content. Run it per milestone, and in CI once tooling exists (OD-17). Measure any new dependency's bundle cost before proposing it. The check also enforces the 3D hero chunk (dynamic import only, ≤ 250 KB gzip).
- Progress updates: render from snapshot plus events (ADR-0018). Throttle UI updates; don't re-render whole pages on every progress event.
