# Phase 2A · M6: seven-agent pipeline visualisation

Acceptance: **Accepted.** Phase 2A was formally accepted on 2026-11-21 after consolidated validation (`../phase2a-validation/README.md` §7). The status line below is kept as written at the time.

Status: **Accepted and closed 2026-11-20** (after the refinements and budget amendment in §5). Frontend only. No backend, contract or dependency changes. No 3D.

## 1. What changed

- **New route `/pipeline`** (lazy chunk), with a "Pipeline" sidebar entry between Recordings and Upload. A recording's
  processing panel links to `/pipeline?recording=<id>`.
- **Diagram (HTML/CSS plus inline SVG; no libraries)**, drawn from one typed topology module
  (`components/pipeline/topology.ts`), following AGENT_ARCHITECTURE §2 exactly:
  - START → **Preprocessing** (a deterministic audio-service stage, not an agent), which forks into two independent
    parallel branches: **A1 Audio Quality**, and **A2 Transcription → A3 Context Intelligence → A4 Research → A5 Fact
    Validation**. The caption reads "A1 does not feed A3 to A5".
  - A dashed **retry loop A5 → A4**: "one targeted research retry per run" (ADR-0014).
  - **A6 Reporting** is the only join and waits for **A1 and A5**, then **A7 QA** (independent, read-only), then END. A7 starts
    after A6; it is independent because it is read-only, not because it runs in parallel.
  - A dashed **A7 → A6** edge is labelled "Proposed (OD-14), not decided".
  - Desktop and tablet use horizontal lanes. Below 768 px the two branches sit side by side in columns.
- **Agent panels.** Every node is a keyboard button (`aria-pressed`; name = visible text "code, name, Planned"; execution
  status via `aria-describedby`). The panel shows kind, responsibility, inputs, outputs, waits for, feeds, may write
  (boundaries), references, capability and execution. It sits beside the diagram from 1296 px; below that it sits under
  the diagram, with focus moved to it and a "Back to diagram" button.
- **List view.** A native `<details>` ordered list gives the full structure as text: dependencies, parallelism, the join,
  the loop and the proposed edge.
- **Status legend and "What runs today".** Implemented: consented upload, resumable upload, signature validation, storage,
  run record at upload, signed playback, service health. Planned: the preprocessing node and A1–A7.

## 2. How real execution state is represented

- **Agent-level execution data does not exist.** The orchestrator runs only the Phase 1 foundation-check worker. The
  run snapshot's `currentStage` is always null, and the only run status that occurs is `created`.
- Every node therefore shows **Capability: Planned** and **Execution: Not connected in this build**. There are no
  progress values, timings, outputs or activity animations.
- `?recording=<id>` loads the real recording and shows its real run status (`created` → **Not started**) with:
  "This run has been recorded but not submitted. Agents do not execute in this build, so no agent-level status
  exists."
- The legend lists Running, Completed and Failed only as values that will appear once agents execute.

## 3. 3D decision

No optional 3D explorer in M6 (Opus determination):
- A seven-node graph with one fork, one join and one bounded loop is clearest in 2D.
- There is no live data for depth to express.
- It would cost about 130 KB of lazy code, and accessibility would still rely on the 2D view.
- ADR-0027 makes the explorer optional, so no approved decision changes.

## 4. Verification

| Check | Result |
| --- | --- |
| Typecheck, lint, build, bundle check, Prettier (changed files) | Passed |
| Web unit tests | 100 passed, unchanged |
| Real browser (production build): 1440, 1280, 820, 412, 360 px; light and dark | 8 nodes. Keyboard select of A5 updates the panel (`aria-pressed`). Recording context shows "Not started" and "not submitted". 0 px horizontal overflow |
| axe (all seven captures) | **0 violations.** A first build had a serious `label-content-name-mismatch` on all nodes; it was fixed by deriving the name from visible text |

E2E was not run; testing is deferred to the phase-level cycle.

## 5. Bundle budgets (KB gzip, critical / combined; limits 175 / 190)

| Route | Before M6 | After M6 |
| --- | --- | --- |
| dashboard | 171.3 / 189.6 | 171.4 / 189.7 |
| upload | 171.1 / 189.4 | 171.2 / 189.5 |
| recording-detail | 169.9 / 188.2 | 170.1 / 188.4 |
| recordings | 169.5 / 187.8 | 169.6 / 187.9 |
| pipeline (new; route chunk 7.3 KB) | n/a | 171.6 / **189.9** |

The new route and sidebar entry add 0.1–0.2 KB to every route.

**Final budget decision (user, 2026-11-20, M6 refinements).** Combined route JS rises from 190 to **205 KB**, and the route
chunk limit from 25 to **30 KB**. Render-critical (175), deferred Motion (20), CSS (20) and 3D (250) are unchanged. There
is no per-route exemption. Enforced in `apps/web/scripts/check-bundle.mjs`, recorded in M0 §5. There is no CI yet (OD-17),
so the check runs per milestone.

| | Before | After |
| --- | --- | --- |
| Combined limit / worst route (pipeline) | 190 / 189.9 (0.1 headroom) | 205 / 189.9 |
| Route-chunk limit / largest chunk (pipeline) | 25 / 7.3 | 30 / 7.3 |
| Render-critical limit / worst route (pipeline) | 175 / 171.6 | 175 / 171.6 (**3.4 headroom, now the binding limit**) |

How the assessment behind the decision works:
- Combined = render-critical + deferred Motion. With those capped at 175 and 20, combined cannot exceed **195 KB**
  while they pass, so the 205 KB limit does not bind on its own.
- A route chunk counts inside its route's render-critical total, so heavy routes cannot reach 30 KB without breaking 175.
- The change cannot degrade initial loading. Practical new room is about 3.4–3.6 KB per heavy route, set by render-critical.
- More room for M7 and M8 would come from loading interaction-only shell UI on demand (the mobile navigation sheet, the
  theme menu, tooltips), which shrinks the about 163.5 KB shared bundle for every route. This is an M1 shell change,
  recommended but not done here.

M6 refinements, the same day: the sidebar health label is now "Core services operational" (it no longer implies the
pipeline is running), and the pipeline caption reads "A1 does not feed A3–A5." (desktop, mobile and list view).
Verified in the browser.

## 6. Screenshots (`screenshots/`)

- `desktop-1440-{dark,light}-pipeline.png`
- `desktop-1280-dark-recording-pipeline.png`
- `tablet-820-light-pipeline.png`
- `mobile-412-dark-pipeline.png`
- `mobile-412-light-recording-pipeline.png`
- `mobile-360-dark-pipeline.png`

Raw results are in `verify-results.json`.

## 7. Limitations and dependencies

- Real per-agent status needs the pipeline phase (orchestrator, LangGraph, stage events via OD-16). The topology can map
  `currentStage` and `error.node` once they carry values; nothing is mapped today.
- The side-by-side panel needs a viewport of at least 1296 px. Below that the panel sits under the diagram.
- The vertical layout applies below 768 px (wider than the original under-640 px target), and branch columns are narrow,
  so long names wrap.
- Clicking the "Pipeline" sidebar link while on `/pipeline?recording=…` does not clear the context, because the router
  tracks the pathname only. Use "Clear".
- The bundle headroom is very tight (§5).
