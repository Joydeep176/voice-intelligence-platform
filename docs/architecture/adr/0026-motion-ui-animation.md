# ADR-0026: Motion for UI animation

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-33
- Affects: `apps/web`, `.claude/skills/frontend-design` (`motion.md`, `SKILL.md`), `.claude/rules/frontend.md`

## Context
The Phase 2A frontend redesign (user decision D1) needs page transitions, panels and tabs that enter and
leave, list reordering after filtering and short confirmation feedback. CSS transitions and
`tw-animate-css` cover hovers and simple state changes, but exit and layout animations are awkward in
pure CSS. The `motion` package was Proposed as an optional dependency (OD-33). The design rules require
motion to explain change, never carry meaning alone, and respect reduced-motion preferences
(`frontend-design/motion.md`).

## Options considered
1. **CSS only** (Tailwind utilities, `tw-animate-css`): no dependency, but exit and layout animation need
   hand-written state machines.
2. **Web Animations API directly**: no dependency, more code, no React integration for presence or layout.
3. **Motion (`motion`, imported from `motion/react`)**: presence, layout and gesture support for React 19;
   `LazyMotion` with `domAnimation` keeps the initial cost small; built-in reduced-motion support.

## Decision
The user approved **Motion** on 2026-11-20 (Phase 2A D1), free features only.

## Consequences
- Import from `motion/react` / `motion/react-m`; never `framer-motion`. Use `LazyMotion` with
  `domAnimation` and the `m` component by default; load heavier features only where needed.
- Wrap the app in `MotionConfig reducedMotion="user"`; reduced motion replaces movement with instant or
  fade transitions.
- **No Motion+ (paid) features, components or templates.**
- CSS remains the default for hovers, focus and simple transitions; Motion is for presence, layout and
  page-level transitions.
- Counts against the Phase 2A initial-JS budget (`docs/design/phase2a-m0-baseline/README.md` §5).
- The package is added in M1, not before; versions and APIs are confirmed via Context7 / the Motion MCP
  at that time.
