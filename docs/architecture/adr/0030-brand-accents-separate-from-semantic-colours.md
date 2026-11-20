# ADR-0030: Brand accents stay separate from semantic colours

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-44
- Affects: `apps/web` (design tokens), `.claude/skills/frontend-design` (`tokens-and-themes.md`)

## Context
The Phase 2A visual identity uses a charcoal/navy foundation with indigo, violet, blue and restrained cyan
accents. Those hues overlap the existing semantic colour families: provenance (recorded ≈ blue, inferred ≈
violet), audio diagnostics (A1) and transcription uncertainty (A2, blue–violet). FR-9.2 requires every
report assertion to show its provenance, and FR-9.3 requires audio diagnostics and transcription
uncertainty to stay visually separate. Brand colour bleeding into those surfaces would blur their meaning.

## Options considered
1. **Re-hue the brand** away from blue/violet: loses the approved visual direction.
2. **Re-hue the semantic families** only: still risks confusion where brand gradients sit next to evidence.
3. **Separate by surface and token family**: brand accents and gradients only in app chrome; semantic
   families keep their own tokens, are tuned for distinctness, and always carry icon and text.

## Decision
The user approved option 3 on 2026-11-20 (Phase 2A D7).

## Consequences
- Brand accents and gradients are used only in chrome: navigation, primary actions, the hero, the
  pipeline visualisation, empty states and branding. They never appear inside evidence surfaces
  (transcript, timeline tracks, report assertions, evidence and validation panels).
- Provenance (`recorded`, `external`, `inferred`), audio diagnostics and transcription uncertainty keep
  separate token families. Diagnostics and uncertainty never share a legend or colour.
- Semantic colours are never the only signal: each carries an icon and a text label.
- Every token pair meets WCAG AA contrast in light and dark themes; the M1 token retune is checked with
  automated contrast tests (ADR-0029).
