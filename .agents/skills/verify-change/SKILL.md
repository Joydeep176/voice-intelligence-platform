---
name: verify-change
description: How to verify a code change without breaking existing behaviour — choosing and running targeted tests, then the affected package suite, and reporting results honestly. Use after every code change once implementation has been approved.
---

# Verifying a change

1. **Find the runner** for each touched package (TESTING_STRATEGY §1): Vitest (`apps/web`, `packages/*`), Jest (`apps/api`, `apps/orchestrator`), Pytest (`services/audio`), Playwright (e2e). Commands are listed in AGENTS.md once scaffolded. If they are missing, look in `package.json` / `pyproject.toml` and do not guess.
2. **Run the targeted tests first**: the test file(s) for the changed module, filtered by file or test name.
3. **Then the affected package's full suite** (via Turborepo filtering when available), plus lint and type-check for that package.
4. **Cross-package changes** (`packages/contracts`, `packages/db`, audio-service API): run the suites of every consumer, and the audio-service contract tests.
5. **Required tests** in TESTING_STRATEGY §3 must keep passing for any feature they cover.
6. **Never** skip, delete, mark-as-expected-failure or loosen assertions to get a pass. If a test seems wrong, explain why and ask.
7. **Report** what ran, what passed and what failed, with output excerpts. Never put transcript or secret content in that output.
