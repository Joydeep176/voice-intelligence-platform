# Performance and lazy loading

- Route-level code splitting with React `lazy` + `Suspense`. Heavy, optional views (3D, large visualisations, export previews) load only when opened.
- Long lists and transcripts: fetch by time range or cursor and render only what is visible. A virtualisation library is OD-37 (Open). Until approved, use windowed rendering built on the paginated APIs.
- Heavy client computation (for example layout of dense timeline data) runs off the main thread in a Web Worker.
- Never load whole transcripts, all sources or full audio up front. Use the paginated, time-ranged endpoints (API §5–6).
- Fonts (OD-38): subset and preload only what is needed. Avoid layout shift.
- Images and icons: SVG or optimised assets with explicit sizes.
- Set and check bundle-size budgets in CI once tooling exists (OD-17). Investigate any new dependency's bundle cost before proposing it.
- Progress updates: render from snapshot plus events (ADR-0018). Throttle UI updates; don't re-render whole pages on every progress event.
