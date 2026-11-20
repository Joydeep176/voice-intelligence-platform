# Accessibility

Target: WCAG 2.2 AA.

- Build on shadcn/ui primitives with the Radix UI base (ADR-0022; scaffold with `--base radix`, since the CLI defaults to Base UI) for dialogs, menus, tabs, tooltips and popovers. Do not re-implement their keyboard/focus behaviour.
- After adding or updating shadcn components, run the shadcn MCP audit checklist (`get_audit_checklist`) and resolve its findings.
- Everything is keyboard operable, with a visible focus ring (token-based) and a logical tab order. Provide a skip-to-content link in the app shell.
- **Never use colour alone.** Provenance, verdicts, severity and speakers always also carry a text label, icon or pattern.
- Media player and timeline: seek controls use slider semantics (`role="slider"` with value text in mm:ss), and play/pause, ±seek and rate are keyboard reachable. The transcript is the text alternative to the audio.
- Live progress uses a polite live region with throttled updates. Do not announce every progress tick.
- Language: set `lang` on transcript and report segments (`hi`, `en`) so screen readers pronounce them correctly. Mixed segments use the dominant language with inline spans where known.
- Respect `prefers-reduced-motion` (see `motion.md`) and support 200% zoom without loss of function.
- Charts and visualisations have an accessible summary and a data-table or list alternative.
- Test with keyboard only, a screen reader, and automated checks: `@axe-core/playwright` in the E2E suite (dev only, ADR-0029), with no serious or critical violations allowed.
