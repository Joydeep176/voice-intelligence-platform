# Motion and interaction

## Library status
**Motion (`motion` package) is approved (ADR-0026), free features only.** CSS transitions and Tailwind utilities stay the default for hovers, focus and simple state changes; Motion is for presence, layout and page-level transitions. Until the package is installed (Phase 2A M1), use CSS only.

## Using Motion
- Import from `motion/react` (React). `framer-motion` is the former package name; do not use it, even if an older docs snippet shows it.
- Wrap the app in `<MotionConfig reducedMotion="user">` so transform/layout animations are disabled for users who prefer reduced motion. Use `useReducedMotion()` for custom cases.
- For bundle size, prefer `LazyMotion` with `domAnimation` and the `m` component (`import * as m from "motion/react-m"`). Load the heavier feature set only where needed.
- Look up patterns via the Motion MCP / Context7 before use. **Never use results labelled Motion+ (paid).**

## Principles (with or without Motion)
- Motion explains change: entering/leaving content, state transitions, focus of attention. It never carries meaning on its own and never delays an action.
- Animate `transform` and `opacity`. Avoid animating layout-heavy properties on large lists.
- Keep durations short and consistent (define them once as tokens), and use consistent easing.
- No motion on data values that could imply a trend that doesn't exist. Progress bars reflect real progress events only.
- Reduced motion: replace movement with instant or fade transitions.
