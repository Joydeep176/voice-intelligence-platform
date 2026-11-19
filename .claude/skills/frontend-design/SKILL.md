---
name: frontend-design
description: Design and implementation standards for the React web app (apps/web) — premium SaaS dashboard layout, design tokens and themes, accessibility, motion, audio waveform and speaker timelines, evidence and provenance presentation, optional 3D, and performance. Use when designing or building any UI in apps/web. Does not authorise new dependencies or start implementation.
---

# Frontend design

Guardrails in `.claude/rules/frontend.md` always apply. This skill adds the detail. Read only the topic files the task needs:

| Task | Read |
|---|---|
| Colours, typography, dark/light theme | `tokens-and-themes.md` |
| Page structure, responsive behaviour | `layout-responsive.md` |
| Any interactive component | `accessibility.md` |
| Transitions, micro-interactions | `motion.md` |
| Player, waveform, speaker timeline, diagnostics/uncertainty tracks | `audio-visualisation.md` |
| Report, claims, verdicts, sources, confidence | `evidence-presentation.md` |
| 3D visualisation (optional) | `3d-optional.md` |
| Bundles, lazy loading, long lists | `performance.md` |

## Non-negotiables
- **Approved stack only:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui. **Motion, Three.js, React Three Fiber, Drei and any waveform, chart, virtualisation or font library are unapproved** (HLD §10, OD-33 to OD-38). Never install or import them without the user's explicit approval.
- **No paid assets:** no Motion+ features, Tailwind Plus templates or paid third-party registries.
- **Provenance:** every report assertion shows `recorded`, `external` or `inferred` (FR-9.2).
- **Two channels:** audio diagnostics and transcription uncertainty are never merged visually or in copy (FR-9.3).
- **Confidence:** never invent numbers. Show a number only when a provider or model supplied it, and label its origin. Otherwise use qualitative wording (`evidence-presentation.md`).
- **Languages:** English, Hindi and Hinglish, with correct Devanagari and mixed-script rendering everywhere.
- **APIs:** look up library APIs with Context7 (and Motion patterns with the Motion MCP) before writing code. Never rely on memory for version-specific APIs.
- **Inspect before `shadcn add`:** first check the item's dependencies (shadcn MCP `view_items_in_registries` / `get_add_command_for_items`). Components can pull in packages implicitly, for example `chart` → `recharts` (OD-36, Open), icons (`lucide-react`), toasts (`sonner`), `cmdk`, `vaul`. Only Radix primitives are covered by ADR-0022. Any other new package needs explicit approval before adding.
- **No Motion agent skill:** do not install Motion's separate agent skill (`npx motion-ai`). This skill's `motion.md` already covers it, and a second copy would duplicate or conflict.

## Preferred Context7 library IDs
Resolve once, then query these IDs. Confirm the version matches the installed package.

| Library | Use | Avoid |
|---|---|---|
| React | `/websites/react_dev_reference`, `/react/react` (v19.x) | `/reactjs/react.dev` (v18 branches) |
| TypeScript | `/microsoft/typescript-website` | |
| Vite | `/vitejs/vite` | |
| Tailwind CSS | `/tailwindlabs/tailwindcss.com` (v4) | `/websites/tailwindcss` (v2/v3) |
| shadcn/ui | `/websites/ui_shadcn` | |
| Motion | Motion MCP first, then `/websites/motion_dev` | any `framer-motion` source |
| Three.js / R3F / Drei | `/mrdoob/three.js`, `/pmndrs/react-three-fiber`, `/pmndrs/drei` | |
