# 3D (React Three Fiber)

**Three.js and React Three Fiber are approved within ADR-0027's limits. Drei is not approved (OD-34b).** Nothing in the product may depend on 3D: every 3D view has a fully functional 2D alternative with the same information and actions.

## Where 3D is allowed
- The **dashboard hero** on capable desktop devices.
- An **opt-in pipeline explorer** (the user opens it).
- Nowhere else without a new decision. Timelines, waveforms and data views stay 2D (canvas/SVG).

## When the hero renders 3D
- Only when all hold: desktop-class viewport, WebGL available, `prefers-reduced-motion` not set, no data-saving preference, tab visible. Otherwise render the 2D SVG version. This automatic hero is the one exception to "2D by default".
- **Mobile and reduced-motion users always get the 2D experience.**
- Load the scene as its own chunk (`lazy` + `Suspense`) after first paint and idle. Never in the initial bundle; 0 bytes when the conditions above fail.

## Rules
- Match versions: `@react-three/fiber` v9 pairs with React 19. Confirm current guidance via Context7 at the time.
- Render on demand: `<Canvas frameloop="demand">`, calling `invalidate()` when state changes, and pause when off screen, so idle scenes use no GPU time. No auto-rotation.
- Keyboard and screen-reader access go through the 2D view; fall back gracefully when WebGL is unavailable or the context is lost.
- One shared, typed pipeline topology drives both the 2D and 3D views. States come only from real run data: never simulate agent activity.
- Colours come from the theme tokens; brand accents follow ADR-0030. Provenance and diagnostics/uncertainty separation rules still apply.
- Respect the Phase 2A 3D budget (`docs/design/phase2a-m0-baseline/README.md` §5).
