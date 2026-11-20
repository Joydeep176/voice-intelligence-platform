# ADR-0031: Add the 3D dashboard-hero packages in Phase 2A M2

- Status: Accepted (hero library amended by ADR-0032: three.js without React Three Fiber)
- Date: 2026-11-20
- Resolves: timing of OD-34a only (amends ADR-0027's "Packages are added in M6b" consequence)
- Affects: `apps/web` (dashboard route), `docs/architecture/HLD.md` §10, `.claude/skills/frontend-design/3d-optional.md`

## Context
ADR-0027 approved Three.js and React Three Fiber for two uses: the desktop dashboard hero and an opt-in
pipeline explorer. Its consequences deferred adding the packages to milestone M6b. The Phase 2A M2
brief (dashboard first) asks for the 3D hero in M2. The user asked that ADR-0027 not be rewritten.

## Options considered
1. **Keep M6b timing**: M2 ships only the 2D SVG hero. No new dependency in M2, but the approved
   dashboard direction (balanced 3D) is incomplete until M6b.
2. **Add the hero packages in M2**: the dashboard is delivered complete in its own milestone. The
   dependency and its budget gate arrive earlier.

## Decision
The user chose option 2 on 2026-11-20. `three` and `@react-three/fiber` (v9, React 19) are added in M2
**for the dashboard hero only**. Everything else in ADR-0027 still applies unchanged:

- 3D only on desktop-class viewports with WebGL, no reduced-motion or data-saving preference, and the tab visible.
- The scene loads as a separate chunk after first paint and idle, and on demand (`frameloop="demand"`).
- No auto-rotation, theme-token colours, and a 2D SVG fallback with the same information.
- 0 bytes of 3D on mobile, reduced-motion, no-WebGL and first-paint paths, and at most 250 KB gzip.

The opt-in pipeline explorer stays in M6b. Drei remains unapproved (OD-34b, Open). Versions and APIs
are confirmed via Context7 when they are installed.

## Consequences
- ADR-0027 is unchanged. Its M6b timing applies only to the pipeline explorer.
- The bundle check gains a 3D budget, so the 250 KB limit and its exclusion from the render-critical
  and deferred-Motion budgets are enforced from M2.
- HLD §10 OD-34a references both ADRs.
