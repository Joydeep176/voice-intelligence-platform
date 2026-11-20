# ADR-0024: lucide-react as the icon library

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-41
- Affects: `apps/web`, `.claude/skills/frontend-design`

## Context
shadcn/ui components (Radix base, ADR-0022) import icons from `lucide-react`, the shadcn default. The frontend-design skill treats any package pulled in by a shadcn component as needing explicit approval, and no icon library had been approved.

## Options considered
1. **lucide-react**: shadcn's default (ISC licence, tree-shakable per-icon imports). Generated components work unchanged.
2. **Local inline SVG icons**: no dependency, but every generated component needs manual edits, which drift from upstream.

## Decision
The user approved **lucide-react** on 2026-11-19 as the single icon library for `apps/web`.

## Consequences
- `components.json` keeps `iconLibrary: "lucide"`. Import icons individually (named imports) so that only the icons used are bundled.
- Icons are never the only signal (accessibility rule). Decorative icons use `aria-hidden`, and icon-only buttons get an accessible name.
- No second icon library without a new ADR.
