# Model routing (developer tooling)

Routes Claude Code work to Haiku, Sonnet or Opus by task category and risk, using only native Claude Code features: project subagents with a `model` field, a project skill, and command hooks. There is no external service, no API key and no new dependency. This is dev tooling, not part of the product. It is unrelated to the seven product agents.

Verified on Claude Code **2.1.329** (2026-11-20). Re-verify after upgrading (see Troubleshooting).

## 1. Architecture

```
 user request
      │
      ▼
 main session (coordinator) ── follows .claude/skills/model-router/SKILL.md
      │   classify → pick agent + model → delegate via Agent tool
      ▼
 PreToolUse(Agent) hook ── .claude/hooks/model-routing.mjs
      │   enforces routing-policy.json: category tag, model floor,
      │   haiku risk scan, agent/category match, file ownership
      │   deny ──► reason returned to coordinator (logged "blocked")
      ▼ allow
 subagent runs on its model (frontmatter, or per-call override)
      │   quick-inspector·documentation-agent (haiku)
      │   frontend/backend/test-engineer·performance-reviewer (sonnet)
      │   architecture-reviewer·security-reviewer (opus)
      ▼
 PostToolUse(Agent) hook ── logs launch + model Claude Code actually resolved
 SubagentStop hook ─────── logs per-model tokens read from subagent transcript
      │
      ▼
 .claude/usage/model-usage.jsonl (gitignored) ──► `… model-routing.mjs report`
```

| Piece | File |
|---|---|
| Policy data (categories, floors, agents, high-risk terms) | `.claude/skills/model-router/routing-policy.json` |
| Coordinator instructions | `.claude/skills/model-router/SKILL.md` |
| Specialist agents | `.claude/agents/{quick-inspector,documentation-agent,frontend-engineer,backend-engineer,test-engineer,performance-reviewer,security-reviewer,architecture-reviewer}.md` |
| Guard and usage logger | `.claude/hooks/model-routing.mjs`, `.claude/hooks/lib/routing.mjs` |
| Hook wiring | `.claude/settings.json` → `hooks` |
| Forced modes | `.claude/modes/{opus,sonnet}-only.json` |
| Tests | `.claude/hooks/tests/model-routing.test.mjs` |

### Verified platform facts

| Fact | How verified |
|---|---|
| `haiku` → `claude-haiku-5-5`, `sonnet` → `claude-sonnet-5-5`, `opus` → `claude-opus-5-5` | headless `claude -p --model <alias>`, `modelUsage` |
| Unknown alias fails closed (`unrecognized_model`); the Agent tool schema rejects unknown `model` values | headless probes |
| Subagent model precedence: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` + `CLAUDE_CODE_SUBAGENT_MODEL` > per-call `model` > agent frontmatter `model` > `CLAUDE_CODE_SUBAGENT_MODEL` (fallback only) > inherit session model | hook capture of `resolvedModel` for each case |
| `PostToolUse(Agent)` exposes `tool_response.resolvedModel` and `agentId` | hook payload capture |
| `SubagentStop` exposes `agent_transcript_path`, whose assistant entries carry `message.model` and `message.usage` | transcript inspection |
| `--settings <file>` applies `model` and `env`, and hooks see that env | headless probe |
| A `PreToolUse` JSON `permissionDecision: "deny"` blocks the Agent call and returns the reason to the model | headless probe |

## 2. Model-selection policy

Rules applied in order:

1. An explicit user choice wins.
2. The highest-risk category that applies wins.
3. If the task is ambiguous, take the higher tier.
4. Haiku is only for read-only or wording-only work.
5. Sonnet is the default for implementation.

| Category | Default model | Floor | Agent(s) | Covers |
|---|---|---|---|---|
| `inspect` | haiku | haiku | quick-inspector, Explore | reads, searches, inventory, config/log inspection, summaries |
| `docs-format` | haiku | haiku | documentation-agent | formatting, typos, small isolated doc edits |
| `docs-technical` | sonnet | sonnet | documentation-agent (+`model: sonnet`) | docs that describe implementation |
| `frontend` | sonnet | sonnet | frontend-engineer | React/UI work, routine fixes, small/medium refactors |
| `backend` | sonnet | sonnet | backend-engineer | routine NestJS/API work |
| `tests` | sonnet | sonnet | test-engineer | unit/integration/E2E/regression tests |
| `code-review` | sonnet | sonnet | general-purpose (+`model: sonnet`) | standard reviews of routine changes |
| `performance` | sonnet | sonnet | performance-reviewer | bundle analysis, frontend performance |
| `planning` | opus | sonnet | Plan (+`model`) | complex/high-risk plans on opus; routine plans may use sonnet |
| `architecture` | opus | **opus** | architecture-reviewer | design, ADR/OD conformance, cross-service, major dependencies |
| `security` | opus | **opus** | security-reviewer | authn/authz, workspace isolation, privacy, secrets |
| `data-integrity` | opus | **opus** | security-reviewer, architecture-reviewer | migrations, provenance, transcript immutability, deletion |
| `complex-debug` | opus | **opus** | general-purpose (+`model: opus`) | hard bugs, concurrency, queues/retries |
| `perf-investigation` | opus | **opus** | performance-reviewer (+`model: opus`), general-purpose | difficult performance investigations |
| `final-review` | opus | **opus** | architecture-reviewer, security-reviewer | milestone/production-readiness reviews, review of high-risk sonnet work |

Phases: Opus plans complex work, Sonnet implements it, and Opus reviews it independently only when the work touched an Opus-floor area, when you asked for `opus-review`, or when it closes a milestone. Trivial work (one read, a one-line edit) stays in the main session. A delegated subagent starts cold, at about 14k cached prompt tokens measured for a Haiku probe, so delegating tiny tasks can cost more than it saves.

### What the hook enforces (deny / ask, never rewrite)

| Rule | Triggers when |
|---|---|
| `unsupported-model` | `model` is not haiku/sonnet/opus (or their full IDs) |
| `missing-category` / `unknown-category` | a routing agent is called without a valid `[category]` tag (all modes) |
| `wrong-agent` | the category is sent to an agent outside its route (all modes) |
| `downgrade-blocked` | the effective model is below the category floor |
| `ambiguous-model` | floor > haiku and the agent would inherit the (unknown) session model |
| `haiku-high-risk` | a write-capable haiku delegation mentions a high-risk term (security, migration, schema, provenance, …) |
| `high-risk-signal` | a sub-Opus delegation that writes, or a `code-review` / `performance` / `planning` task, mentions an Opus-domain term (security, auth, permission, secret, privacy, migration, schema, drizzle, provenance, transcript version, immutab…, deletion, concurrency, architecture, ADR-) outside an Opus category. Exempt: `inspect`, `docs-technical`, read-only agents outside routing (`test-strategist`, untagged `Explore`), and tasks tagged `[opus-review-follows]` |
| `override-mismatch` | `[override:X]` is not paired with `model: X` |
| `missing-ownership` | a write-capable routing agent has no `Owned files:` line (and no worktree isolation) |
| `ownership-conflict` | owned paths overlap a still-running writer in the same session |

**Below-tier runs need your confirmation.** The tier rules (`downgrade-blocked`, `haiku-high-risk`, `high-risk-signal`) normally **deny**. When you chose the lower model yourself, with `[override:X]` or a forced mode, the hook returns `permissionDecision: "ask"` instead. Claude Code then shows `⚠ model-router: BELOW REQUIRED MODEL TIER (…)` and waits for you to approve or deny. That applies to Sonnet-only mode too: Opus-floor and Opus-domain work prompts you, it is never waved through. Overrides at or above the floor (e.g. `[override:opus]` on an inspection) need no confirmation. Ownership and category rules still deny in every mode. If the guard itself errors, it fails closed and denies the call.

`[opus-review-follows]` is the policy-conformant way to have Sonnet implement Opus-domain work (Opus plans, Sonnet implements, Opus reviews). It lifts `high-risk-signal` for that task. The usage report then lists any tagged task with no later Opus review (opus model, Opus-floor category) in the same session.

## 3. Agent responsibilities

| Agent | Model | Writes | Responsibility | Escalates on |
|---|---|---|---|---|
| quick-inspector | haiku | no (Read/Grep/Glob) | facts: search, read, inventory, summaries | anything needing judgement |
| documentation-agent | haiku (sonnet for `docs-technical`) | owned docs only; never ADRs or the HLD §10 register | wording, formatting, small doc edits | implementation knowledge, architecture, decisions |
| frontend-engineer | sonnet | owned files in `apps/web` | approved UI work; `frontend` rule and `frontend-design` skill | architecture, security, provenance, dependencies, hard bugs |
| backend-engineer | sonnet | owned files in `apps/api`/`apps/orchestrator` | approved routine backend work | architecture, security, schema/migration, concurrency |
| test-engineer | sonnet | owned test files only | tests per TESTING_STRATEGY; never weakens tests | suspected bugs, ambiguous behaviour, isolation/provenance guarantees |
| performance-reviewer | sonnet (opus for `perf-investigation`) | no (Bash for build/measure only) | measure and recommend | causes not visible from build/code |
| architecture-reviewer | opus | no | conformance with docs, ADRs and HLD §10 | undecided OD / Proposed design → user |
| security-reviewer | opus | no | security and data integrity | undecided decisions, missing files |

Every agent returns `STATUS: done | partial | escalate | blocked` and an `ESCALATION:` line. Subagents cannot spawn other agents, so escalation always goes back through the coordinator. `test-strategist` (read-only test planning) now has `model: sonnet`. Its instructions are planning against TESTING_STRATEGY with no design or security judgement, so nothing called for Opus. It stays outside the category routes, so no tag is needed. The vendored `impeccable-*` agents are unchanged (`model: inherit`) and outside routing.

## 4. Escalation rules

| Situation | Action |
|---|---|
| Haiku hits implementation, judgement or a high-risk term | Re-delegate in a Sonnet category with `[escalated-from:haiku]` |
| Sonnet hits architectural ambiguity | `architecture` (Opus) with `[escalated-from:sonnet]` |
| Sonnet hits a security or data-integrity concern | `security` / `data-integrity` (Opus) |
| An agent returns `escalate`, fails verification, or is unreliable | One re-delegation at the next tier |
| An Opus task fails, or a model is unavailable or rejected | Stop, report, and ask you for an approved alternative. No silent fallback |
| High-risk work implemented on Sonnet | Independent Opus review before it is called done |

An escalation is reported only if a second delegation actually ran. It then appears in the usage log as a launch with `escalatedFrom`.

## 5. Override commands

| You want | Do this |
|---|---|
| Automatic routing | Nothing (CLAUDE.md activates the skill), or `/model-router <task>` |
| Automatic routing with an Opus review | `/model-router opus-review <task>` or say "with Opus review" |
| Routing plan only (no delegation) | `/model-router plan-only <task>` |
| A specific model for one task | "use haiku / sonnet / opus for <task>", or `/model-router opus <task>`. The coordinator passes `model` + `[override:X]`. At or above the floor it just runs. Below the floor (or Haiku on high-risk edits, or Sonnet on Opus-domain work) Claude Code shows a ⚠ warning and **waits for your confirmation** |
| Opus-only (session + all subagents) | `claude --settings .claude/modes/opus-only.json` |
| Sonnet-only (session + all subagents) | `claude --settings .claude/modes/sonnet-only.json` |
| Change only the coordinator's model | `/model sonnet` · `/model opus` · `/model opusplan` (Opus in plan mode, Sonnet otherwise) · `claude --model <alias>` |

The coordinator's model matters most for cost, because the main session does the classification and all inline work. Running it on Sonnet (or `opusplan`) while Opus is used through `planning` / reviewer agents is the main saving lever. This repo does not set it for you. Forced modes are per launch: exit and restart without `--settings` to return to automatic routing. Sonnet-only mode still prompts you before any Opus-floor or Opus-domain delegation runs on Sonnet.

### `opusplan` with routing

`opusplan` is a **main-session** setting. On 2.1.329 the binary describes it as "Opus in plan mode, else Sonnet" (static inspection, no live call). Nothing in it selects subagent models: subagents follow the precedence in §1.

| Work | Model under `/model opusplan` | Source |
|---|---|---|
| Planning turns in plan mode (shift+tab twice) | Opus (main session) | `opusplan` |
| Implementation and coordination turns outside plan mode | Sonnet (main session) | `opusplan` |
| Routing agents (quick-inspector … security-reviewer, test-strategist) | Their frontmatter `model`, or the per-call `model` | agent definition / coordinator |
| Built-in agents with a `model` passed (`Plan`, `general-purpose`) | The passed model | coordinator |
| Agents that inherit (`impeccable-*`, built-ins without `model`) | **Unverified**: presumably the main session's current model, which depends on plan mode | — |

Compatibility: the guard never lets inheritance decide an Opus/Sonnet-floor task (`ambiguous-model`), so `opusplan`'s plan-mode switching can't silently downgrade routed work. One caveat: complex planning delegated to `Plan` with `model: opus` is independent of plan mode. Planning done inline outside plan mode runs on Sonnet. Use plan mode, or the `planning` category, for Opus-quality plans. Confirming the inherit behaviour needs one live run (not done; awaiting approval).

## 6. Usage reporting

```
node .claude/hooks/model-routing.mjs report              # latest session
node .claude/hooks/model-routing.mjs report --all        # every session
node .claude/hooks/model-routing.mjs report --session <id>
```

Records in `.claude/usage/model-usage.jsonl` (gitignored, local only):

| Event | Fields |
|---|---|
| `launch` | task label (description with tags stripped, ≤ 80 chars), agent, category, requested model and its source, **resolved model from Claude Code**, override/forced/escalated-from, launch status, session id, transcript path |
| `complete` | agent id/type, per-model tokens (input, output, cache read/write, API calls) summed from the subagent transcript, de-duplicated by message id |
| `blocked` | agent, category, requested model, guard rule |
| `confirm-requested` | as `blocked`, plus the below-tier reasons. A later `launch` with the same tool-use id means you confirmed it, and its `belowFloor` field lists the reasons. No launch means it was declined |

The report also sums the main session's tokens by model from its transcript. Prompts, file contents and transcript text are never logged. Keep task labels free of sensitive content.

Missing data is shown as `unavailable` and never estimated. Completion status is `stopped`, because Claude Code's `SubagentStop` does not say whether the agent succeeded; read the agent's `STATUS` line for that. **Cost is not estimated:** subscription usage is not billed per token, and Claude Code exposes no reliable per-subagent price. Use `/usage` (plan limits) or `/cost`.

## 7. Limitations (Claude Code)

- Routing judgement is the coordinator model following the skill. Hooks can block bad delegations but cannot choose an agent or split a task.
- The hook can't see the main session's model. It denies Opus/Sonnet-floor delegations that would inherit it, and allows inheritance only for haiku-floor work.
- Work the main session does inline is not routed or blocked. It is only visible in the main-session token totals.
- The high-risk term scan is a keyword heuristic. It applies only to write-capable Haiku delegations and can produce false positives; re-route to Sonnet.
- File ownership is enforced only between subagents that declare `Owned files:`, within one session, and for ~90 minutes after launch (stale records expire). The main session's own edits are not checked.
- `[override:X]` and `[opus-review-follows]` rely on the coordinator using them as instructed. Every below-tier override still needs your confirmation, and every use is logged and reported.
- The `ask` decision is confirmed valid for this build from the binary's hook schema (`allow | deny | ask | defer`), not from a live session. In non-interactive `claude -p` runs no one can confirm, so expect those calls not to run.
- Forced modes need a restart. `/model` mid-session changes only the main session.
- Only `haiku`, `sonnet` and `opus` are permitted by policy. Other models Claude Code offers are denied until added to `routing-policy.json`.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Agent call denied with `model-router: …` | Follow the reason (add the tag, pass the model, declare ownership). `report` lists blocked calls |
| `ownership-conflict` after an agent crashed | `node .claude/hooks/model-routing.mjs reset-writers` |
| `model-router guard error` | Run the tests. To disable temporarily, remove the `hooks` block from `.claude/settings.json` |
| `resolvedModel: unavailable` / tokens `unavailable` | The Claude Code version no longer exposes the field. Re-verify (below) |
| After a Claude Code upgrade | `claude --version`; `node --test .claude/hooks/tests/`; re-check precedence and payload fields as in §1 before relying on the logs |

## 9. Testing

`node --test .claude/hooks/tests/` runs 123 tests. They cover the 10 required properties plus the revised risk-floor behaviour: below-tier overrides and Sonnet-only mode return `ask` for every Opus-floor category × agent; Opus-domain terms in Sonnet categories are denied unless tagged; the missing-Opus-review report; the `ask` hook protocol and confirmed/declined reporting; `test-strategist`'s model. Areas covered: Haiku/Sonnet/Opus routing, no silent downgrade (every Opus-floor category × agent × lower model), escalation paths, overrides and forced modes, unsupported aliases, file ownership (including the parallel-hook state file), usage logging that records `unavailable` rather than guessing and never logs prompts, and conformance of agent definitions and settings with the project rules. They use synthetic payloads only. They are not part of `pnpm test`, because this is not an application package.

Live check (uses subscription usage, optional): in a session, run `/model-router <small read-only task>`, then `report` and confirm `resolvedModel` matches the policy.

## 10. Example workflows

1. **"Where are queue settings defined?"** → `inspect` → quick-inspector (Haiku).
2. **"Fix typos in SETUP.md"** → `docs-format` → documentation-agent (Haiku), `Owned files: docs/development/SETUP.md`. If the edit turns out to explain migrations, the hook denies it (`haiku-high-risk`) and the coordinator re-delegates as `[docs-technical] [escalated-from:haiku]` with `model: sonnet`.
3. **"Build the approved recordings filter + tests"** → frontend-engineer and test-engineer (Sonnet), in parallel with disjoint `Owned files:`. A Sonnet `code-review` follows. No Opus.
4. **"Add workspace-scoped deletion endpoint"** → Opus `planning` → backend-engineer (Sonnet) implements as `[backend] [opus-review-follows] …` (without the tag, "deletion" triggers `high-risk-signal`) → security-reviewer (Opus, `data-integrity`) reviews. If the review is skipped, the report flags it.
5. **"Use haiku for this security review"** → security-reviewer with `model: haiku`, `[override:haiku]`. Claude Code shows the ⚠ BELOW REQUIRED MODEL TIER warning and runs only if you approve. The report lists it as confirmed or declined.
6. **M1 close-out** → `final-review` with architecture-reviewer + security-reviewer (Opus) in parallel (both read-only).
