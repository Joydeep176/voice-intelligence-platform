# ADR-0022: Radix UI as the shadcn/ui component base

- Status: Accepted
- Date: 2026-11-19
- Resolves: OD-40
- Affects: HLD §2 and §10, `apps/web` scaffolding (LLD §1), `.claude/skills/frontend-design`

## Context
The approved frontend stack is React + TypeScript + Vite, Tailwind CSS and shadcn/ui (HLD §2). shadcn/ui now supports two primitive libraries for its components, Radix UI and Base UI. Since the shadcn CLI v4 changelog of July 2026, `shadcn init` defaults to **Base UI**, so scaffolding without an explicit choice would silently pick a base the architecture never chose. The web app depends heavily on accessible primitives (dialogs, menus, tabs, tooltips, popovers, sliders) for WCAG 2.2 AA (`frontend-design/accessibility.md`), keyboard-operable media controls and the transcript workspace.

## Options considered
1. **Radix UI**: the long-standing shadcn base, with the largest body of shadcn examples, registry items and community knowledge. Its keyboard and focus behaviour is mature. It is no longer the CLI default, so it must be requested explicitly.
2. **Base UI**: the current CLI default. It is newer, with fewer examples and less third-party registry coverage today.

## Decision
Use **Radix UI** as the shadcn/ui component base for `apps/web`, chosen by the user on 2026-11-19 for its maturity, accessibility track record and wider example and registry coverage.

## Consequences
- Scaffolding must pass the base explicitly (`shadcn init --base radix`, short form `-b radix`), including in any non-interactive script or CI. Confirm the flag via Context7 at scaffolding time.
- `components.json` records the Radix base. Components added later must be Radix variants. Do not mix Base UI components into the app.
- Radix packages arrive as transitive dependencies of shadcn components. This ADR covers only those primitives. Every other package a component pulls in (icons, charts, toasts and so on) still needs the dependency inspection in `frontend-design/SKILL.md` and, where an OD applies, separate approval.
- Switching to Base UI later would need a new ADR that supersedes this one, plus a migration of the components.
- This decision does not approve scaffolding or any implementation. It applies when `apps/web` scaffolding is approved.
