# Optional 3D (React Three Fiber)

**Three.js, React Three Fiber and Drei are unapproved optional dependencies (OD-34).** Do not install or import them without explicit approval. Nothing in the product may depend on 3D.

## If approved
- 3D is an optional enhancement only. Every 3D view has a fully functional 2D alternative with the same information and actions, and the 2D view is the default.
- Lazy-load the 3D view as its own chunk (`lazy` + `Suspense`) only when the user opens it. Never in the initial bundle.
- Match versions: `@react-three/fiber` v9 pairs with React 19 (v8 with React 18). Confirm current guidance via Context7 at the time.
- Render on demand: `<Canvas frameloop="demand">`, calling `invalidate()` when state changes, so idle scenes use no GPU time.
- Consider Drei's `AdaptiveDpr` / performance-monitor helpers for weaker devices (verify the current API via Context7).
- Respect reduced motion (no auto-rotation), provide keyboard alternatives through the 2D view, and fall back gracefully when WebGL is unavailable.
- Colours come from the theme tokens. Provenance and diagnostics/uncertainty separation rules still apply.
