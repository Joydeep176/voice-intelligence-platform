# ADR-0027: Three.js and React Three Fiber for the desktop 3D hero and pipeline explorer

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-34a (OD-34 split: Drei is OD-34b, still Open)
- Affects: `apps/web`, `.claude/skills/frontend-design` (`3d-optional.md`, `SKILL.md`), `.claude/rules/frontend.md`

## Context
The Phase 2A redesign (user decision D2, "balanced 3D") calls for a genuinely attractive 3D dashboard
hero on capable desktop devices and an interactive, opt-in 3D exploration of the seven-agent pipeline
(AGENT_ARCHITECTURE §2, ADR-0021). OD-34 proposed Three.js, React Three Fiber and Drei as optional,
lazy-loaded dependencies with a functional 2D alternative. The frontend-design rules previously made the
2D view the default everywhere and loaded 3D only on request.

## Options considered
1. **No 3D**: CSS 3D transforms and SVG only. No dependency; limited depth and interactivity.
2. **`ogl` or raw WebGL**: smaller, but much more hand-written code and a thin ecosystem.
3. **Three.js with React Three Fiber v9** (pairs with React 19): mature, declarative, on-demand rendering
   (`frameloop="demand"`).

## Decision
The user approved **Three.js with React Three Fiber** on 2026-11-20 (Phase 2A D2), with restrictions:

- **Where:** the dashboard hero on capable desktop devices, and an opt-in "explore" view of the pipeline.
  Nowhere else without a new decision. Timelines, waveforms and data views stay 2D (canvas/SVG).
- **When the hero shows 3D:** only when all hold: desktop-class viewport, WebGL available,
  `prefers-reduced-motion` not set, no data-saving preference, tab visible. It loads as a separate chunk
  after first paint and idle. Otherwise the 2D SVG version is shown. This is a deliberate exception to
  the earlier "2D by default" rule, for the hero only.
- **Mobile and reduced-motion users always get the 2D experience.** The pipeline explorer is opt-in.
- **Always:** a 2D SVG fallback with the same information, keyboard and screen-reader access through the
  2D view, no auto-rotation, on-demand rendering paused when off screen, theme colours from the shared
  tokens, and pipeline states only from real run data (no simulated agent activity).

Drei (OD-34b) is **not** approved by this decision; any Drei helper needs separate approval.

## Consequences
- The 3D chunk follows the Phase 2A budget: 0 bytes on mobile, reduced motion, no WebGL and first paint.
- One shared, typed pipeline topology drives both the 2D and 3D views so they cannot diverge.
- Packages are added in M6b, not before; versions and APIs are confirmed via Context7 at that time.
- `frontend-design/3d-optional.md` is updated to the rules above.
