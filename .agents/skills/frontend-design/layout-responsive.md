# Layout and responsive design

## App shell (premium SaaS dashboard)
- Persistent sidebar navigation (collapsible; a sheet/drawer on small screens), top bar with workspace switcher, theme toggle and user menu, and a content area with a consistent max width and spacing scale.
- Page anatomy: title + primary action, status/summary row, main content, secondary panels. Keep one primary action per view.
- Generous whitespace, restrained colour, clear hierarchy. Density comes from structure (tables, tabs), not from shrinking text.

## Key screens (from LLD §9)
Recordings list, upload (with consent attestation), run detail (stage progress), transcript workspace (player + waveform + speaker timeline + transcript + correction editor), report (HTML, provenance per assertion), exports.

## Responsive rules
- Mobile-first Tailwind breakpoints for page layout. Use Tailwind v4 container queries (`@container`, `@md:` etc.) for components that live in panels of varying width (cards, side panels).
- The transcript workspace stacks vertically on narrow screens (player and timeline on top, transcript below). The timeline stays horizontally scrollable inside its container, with **no page-level horizontal scroll**.
- Tables: on narrow screens, show priority columns and move the rest to row details. Never shrink text below the readable minimum.
- Test at phone, tablet and desktop widths and in both themes.

## States
Every data view has loading (skeletons matching the final layout), empty (what to do next), error (problem-detail message, retry, no content echoed) and partial states (for example a run still in progress, or a report marked `needs_review`).
