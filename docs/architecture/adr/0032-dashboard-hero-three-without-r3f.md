# ADR-0032: The dashboard 3D hero uses three.js without React Three Fiber

- Status: Accepted
- Date: 2026-11-20
- Resolves: implementation library for the dashboard hero under OD-34a (narrows ADR-0027's chosen option for the hero only)
- Affects: `apps/web` (dashboard hero), `docs/architecture/HLD.md` §10, `.claude/skills/frontend-design/3d-optional.md`

## Context
ADR-0027 chose Three.js with React Three Fiber, under a 3D budget of at most 250 KB gzip
(`docs/design/phase2a-m0-baseline/README.md` §5). ADR-0031 moved the hero packages to M2. Before any
UI was built, M2 measured the cost with Vite (gzip, excluding modules already shared with `react-dom`):

| Bundle | Size |
| --- | --- |
| three + React Three Fiber, trivial scene | 256.6 KB (three ~195 KB: R3F imports the whole `three` namespace, so tree-shaking cannot apply; R3F + bundled reconciler ~61 KB) |
| Plain three.js, tree-shaken imports, equivalent scene | ~137 KB |

A real hero scene with R3F would be about 259–261 KB, over budget.

## Options considered
1. **Plain three.js** (~140 KB with the React wrapper): within budget with ~110 KB headroom. The scene is
   written imperatively instead of as JSX.
2. **Keep R3F and raise the budget to 265 KB**: keeps ADR-0027's option, but leaves almost no headroom.
3. **2D hero only in M2**: no 3D dependency.

## Decision
The user chose option 1 on 2026-11-20. The dashboard hero uses `three` only, with named (tree-shaken)
imports, in a lazily loaded module. `@react-three/fiber` is not installed in M2. All other ADR-0027
restrictions apply unchanged:

- desktop-class viewport, WebGL, no reduced-motion or data-saving preference, tab visible;
- separate chunk loaded after first paint and idle;
- rendering on demand only (no continuous loop), paused when off screen;
- no auto-rotation; theme-token colours;
- a 2D SVG fallback;
- 0 bytes on fallback paths;
- at most 250 KB gzip.

Drei remains unapproved (OD-34b).

## Consequences
- React Three Fiber stays approved by ADR-0027 for the M6b pipeline explorer, subject to the same
  budget being measured again at that time.
- The hero manages the renderer lifecycle itself: resize, dispose on unmount, and WebGL context loss
  falling back to 2D.
- The bundle check enforces the 250 KB 3D budget.
