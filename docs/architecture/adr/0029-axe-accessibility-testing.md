# ADR-0029: axe-core for automated accessibility testing in Playwright

- Status: Accepted
- Date: 2026-11-20
- Resolves: OD-43
- Affects: `apps/web` (dev dependencies, E2E tests), `docs/architecture/TESTING_STRATEGY.md`, `.claude/skills/frontend-design/accessibility.md`

## Context
The frontend targets WCAG 2.2 AA (`frontend-design/accessibility.md`). Automated checks were listed as a
candidate pending a dependency decision. The Phase 2A M0 baseline ran `@axe-core/playwright` 4.14.0
(axe-core 4.14.1) from an isolated install against the current UI: it is compatible with Playwright
1.65.1 (peer `playwright-core >= 1.0.0`) and found two serious issues
(`docs/design/phase2a-m0-baseline/README.md` §2).

## Options considered
1. **Manual audits only**: no dependency; regressions go unnoticed between audits.
2. **`@axe-core/playwright`**: runs axe-core inside the existing Playwright E2E suite; development only,
   no bundle impact; MPL-2.0 licence.
3. **Lighthouse CI**: broader, heavier, and mainly a performance tool.

## Decision
The user approved **`@axe-core/playwright` as a development-only dependency** of `apps/web` on 2026-11-20
(Phase 2A D8).

## Consequences
- Added as a `devDependency` of `apps/web` only; it is never imported by application code.
- E2E tests run axe with the WCAG 2.x A/AA and best-practice tags. Budget: no serious or critical
  violations in any scanned screen.
- Automated checks cover only part of WCAG; keyboard-only and screen-reader walkthroughs remain part of
  acceptance.
- Licence MPL-2.0 (file-level copyleft) is acceptable for a test-only tool that is not distributed.
- Added in M1.
