---
name: model-router
description: Routes engineering work to the cheapest adequate Claude model (Haiku / Sonnet / Opus) through the project's specialist subagents. Use for multi-step or delegable engineering work — inspections, docs, frontend/backend implementation, tests, reviews, debugging — and when the user names a routing mode or model ("use haiku/sonnet/opus", "opus review", "plan only", "route this"). Not needed for a one-line answer or edit.
argument-hint: '[auto | opus-review | plan-only | haiku | sonnet | opus] <task>'
---

# Model router

Detailed docs: `docs/development/MODEL_ROUTING.md`. Policy data: `routing-policy.json` (this folder) — categories, floors, agents, high-risk terms. The `PreToolUse` hook `.claude/hooks/model-routing.mjs` enforces it and logs usage; it denies, it never silently rewrites.

Routing never widens scope. `CLAUDE.md`, `.claude/rules/`, approved ADRs, phase/milestone approval and the no-commit/no-push rule bind every agent exactly as they bind you.

## 0. Mode and user overrides (highest priority)

Read the user's words and the skill argument first. An explicit user choice always wins over the policy.

| User says / argument | Effect |
|---|---|
| nothing, `auto` | Automatic routing (below). |
| `opus-review` / "with Opus review" | Automatic routing, plus a mandatory `final-review` Opus pass over all changes. |
| `plan-only` / "dry run" | Produce the routing plan table only. Delegate nothing, edit nothing. |
| `haiku` / `sonnet` / `opus`, or "use X for <task>" | Run that task (or all tasks, if unscoped) on X: pass `model: "X"` and tag `[override:X]`. |
| Session started with `.claude/modes/opus-only.json` or `sonnet-only.json` | All subagents are forced to that model by Claude Code. Still tag and classify every delegation: in Sonnet-only mode, Opus-floor or Opus-domain work triggers a confirmation prompt. |

`[override:X]` is only for an explicit user choice. Never add it yourself to get past the guard. When an override or a forced mode puts a task below its required tier (an Opus-floor category, Haiku on high-risk edits, or Opus-domain terms in a Sonnet category), the hook returns `ask`. Claude Code shows the user a "⚠ BELOW REQUIRED MODEL TIER" warning and waits for confirmation. Before the call, tell the user in one line that a confirmation is coming and why. If they decline, don't retry at a lower tier: offer the policy tier instead. Overrides at or above the floor need no confirmation.

## 1. Classify (deterministic)

Split the request into tasks. For each, pick the category from `routing-policy.json` by these rules, in order:

1. **Highest risk wins.** If any part of a task fits an Opus-floor category (`architecture`, `security`, `data-integrity`, `complex-debug`, `perf-investigation`, `final-review`), that is the category.
2. **Ambiguous → higher tier.** Unsure between two categories, take the higher-floor one.
3. **Haiku only for read-only (`inspect`) or wording-only (`docs-format`) work.** Never Haiku for decisions, security-sensitive work, schema/migration design, data-integrity changes or broad refactors.
4. **Sonnet is the default for implementation** (`frontend`, `backend`, `tests`, `docs-technical`, `code-review`, `performance`).
5. **Planning:** routine plans in the main session; complex or high-risk plans → `planning` with `Plan` on `opus` (unless the main session is already Opus).

Don't delegate trivial work. A subagent starts cold (measured: ~14k cached prompt tokens before it does anything), so a single read or one-line edit is cheaper inline. Delegate when a task needs several tool calls, reads a lot, writes code, needs an independent reviewer, or can run in parallel.

## 2. Delegate

Each Agent call:

- `subagent_type`: an agent listed for the category.
- `description`: `[<category>] <3–6 word task label>`. Add `[escalated-from:<model>]` on an escalation and `[override:<model>]` for a user override. Add `[opus-review-follows]` only when a Sonnet task implements security, architecture or data-integrity work under an Opus plan **and** you will run an Opus review afterwards: the hook otherwise denies Opus-domain terms in Sonnet categories (`high-risk-signal`), and the usage report flags tagged work that never got its Opus review. The label is logged, so keep it free of secrets, personal data and transcript text.
- `model`: pass it whenever the category's `tier` differs from the agent's default (e.g. `docs-technical` → `sonnet` on `documentation-agent`, `perf-investigation` → `opus` on `performance-reviewer`, `complex-debug` → `opus` on `general-purpose`). Built-in agents (`general-purpose`, `Plan`, `Explore`) have no model of their own, so always pass `model` for them.
- `prompt`: the task, its acceptance check, the approved scope/milestone, relevant files and docs, and for write-capable agents an `Owned files:` line (comma-separated or `-` bullets) listing every path the agent may change. Agents start without this conversation: give them what they need.

If the hook denies a call, read the reason and fix the call (add the tag, raise the model, declare ownership, wait for a conflicting writer). Never retag to a lower category to get past it.

## 3. Phases

| Phase | Default |
|---|---|
| Planning | Main session for routine work; `planning` (Opus) for complex or high-risk work. |
| Implementation | Sonnet engineers; Haiku only for `inspect` / `docs-format`. |
| Verification | Agent runs `verify-change` itself; you re-check the claims (step 5). |
| Final review | Opus (`architecture-reviewer` / `security-reviewer`) **only** when the work touched an Opus-floor area, the user asked for `opus-review`, or it closes a milestone. Otherwise a Sonnet `code-review` or none. |

Don't put every step on Opus. Opus plans and reviews high-risk work; Sonnet implements it.

## 4. Parallelism and file ownership

- Run tasks in parallel only if neither needs the other's output.
- Read-only agents (`quick-inspector`, reviewers, `Plan`, `Explore`) can always run in parallel.
- Write-capable agents in parallel need disjoint `Owned files:`. The hook blocks overlapping ownership with a running writer in the same session. Use `isolation: "worktree"` when work genuinely overlaps.
- While a writer runs, you don't edit its owned files.
- Never give a subagent scope beyond what the user approved.

## 5. Validate, then escalate

For each result:

1. Read `STATUS`. Check that `FILES CHANGED` ⊆ `Owned files` (`git status --porcelain`) and that the verification it reports actually ran (re-run targeted tests if in doubt).
2. `STATUS: escalate`, a failed check, or an unreliable result → re-delegate **once** at the next tier with `[escalated-from:<model>]` and the agent's escalation note. Haiku → Sonnet category; Sonnet → Opus category for architecture, security, data-integrity or hard-bug concerns.
3. An Opus task that fails, or a model that is unavailable or rejected → stop and report to the user; ask for an approved alternative. Never fall back to a lower model on your own.
4. Report an escalation only if a second delegation actually happened (it shows up in the usage log).
5. High-risk work implemented on Sonnet gets an independent Opus review before you call it done.

## 6. Report

End with a routing table built from what actually ran: the Agent results' resolved model, or `node .claude/hooks/model-routing.mjs report`. Never fill in an assumed model or token count.

```
| Task | Category | Agent | Requested → resolved model | Status | Escalation |
```

After it: verification results (including failures), files changed, anything blocked by the guard, below-tier runs the user confirmed or declined, and any `[opus-review-follows]` work still missing its Opus review. Token usage comes from the report command; cost is not estimated (see the docs).
