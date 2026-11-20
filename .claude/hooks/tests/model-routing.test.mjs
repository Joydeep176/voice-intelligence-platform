// Model-routing tests. Run: node --test .claude/hooks/tests/
// Synthetic payloads only; no network, no Claude calls. See docs/development/MODEL_ROUTING.md §Testing.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RANK,
  effectiveModel,
  evaluateDelegation,
  missingOpusReviews,
  normalizeModel,
  parseOwnedFiles,
  parseTags,
  pathsOverlap,
  readAgentDefinition,
  summarizeTranscript,
  taskLabel,
} from '../lib/routing.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HOOK = join(ROOT, '.claude/hooks/model-routing.mjs');
const policy = JSON.parse(readFileSync(join(ROOT, '.claude/skills/model-router/routing-policy.json'), 'utf8'));
const def = (type) => readAgentDefinition(ROOT, type);

function decide(toolInput, { env = {}, activeWriters = [] } = {}) {
  return evaluateDelegation({ toolInput, policy, definition: def(toolInput.subagent_type), env, activeWriters });
}

const owned = (paths) => `Do the task.\nOwned files: ${paths}\n`;

describe('1. simple tasks route to Haiku', () => {
  it('inspect and docs-format categories default to haiku agents', () => {
    assert.equal(policy.categories.inspect.tier, 'haiku');
    assert.equal(policy.categories['docs-format'].tier, 'haiku');
    assert.equal(def('quick-inspector').model, 'haiku');
    assert.equal(def('documentation-agent').model, 'haiku');
  });
  it('a repository search on quick-inspector is allowed on haiku', () => {
    const r = decide({ subagent_type: 'quick-inspector', description: '[inspect] List NestJS modules', prompt: 'List modules.' });
    assert.equal(r.decision, 'allow');
    assert.equal(r.info.requestedModel, 'haiku');
  });
  it('read-only haiku may inspect high-risk areas (it cannot change them)', () => {
    const r = decide({ subagent_type: 'quick-inspector', description: '[inspect] Find migration files', prompt: 'Find drizzle migration files.' });
    assert.equal(r.decision, 'allow');
  });
  it('a README typo fix on documentation-agent is allowed on haiku', () => {
    const r = decide({ subagent_type: 'documentation-agent', description: '[docs-format] Fix README typos', prompt: owned('README.md') });
    assert.equal(r.decision, 'allow');
    assert.equal(r.info.requestedModel, 'haiku');
  });
});

describe('2. standard implementation routes to Sonnet', () => {
  for (const [agent, category, files] of [
    ['frontend-engineer', 'frontend', 'apps/web/src/components/Foo.tsx'],
    ['backend-engineer', 'backend', 'apps/api/src/health/health.controller.ts'],
    ['test-engineer', 'tests', 'apps/web/src/components/Foo.test.tsx'],
  ]) {
    it(`${category} on ${agent} resolves to sonnet from frontmatter`, () => {
      const r = decide({ subagent_type: agent, description: `[${category}] Routine change`, prompt: owned(files) });
      assert.equal(r.decision, 'allow');
      assert.deepEqual([r.info.requestedModel, r.info.modelSource], ['sonnet', 'frontmatter']);
    });
  }
  it('performance-reviewer defaults to sonnet', () => assert.equal(def('performance-reviewer').model, 'sonnet'));
});

describe('3. complex architectural and high-risk tasks route to Opus', () => {
  for (const agent of ['architecture-reviewer', 'security-reviewer']) {
    it(`${agent} is pinned to opus`, () => assert.equal(def(agent).model, 'opus'));
  }
  it('architecture review resolves to opus', () => {
    const r = decide({ subagent_type: 'architecture-reviewer', description: '[architecture] Review queue design', prompt: 'Review.' });
    assert.equal(r.decision, 'allow');
    assert.equal(r.info.requestedModel, 'opus');
  });
  it('complex debugging on general-purpose is allowed with model opus', () => {
    const r = decide({ subagent_type: 'general-purpose', description: '[complex-debug] Stalled job retries', model: 'opus', prompt: 'Investigate.' });
    assert.equal(r.decision, 'allow');
  });
});

describe('4. high-risk tasks cannot silently downgrade', () => {
  const opusCategories = Object.entries(policy.categories).filter(([, c]) => c.floor === 'opus');
  for (const [category, c] of opusCategories) {
    for (const agent of c.agents) {
      for (const model of ['haiku', 'sonnet']) {
        it(`[${category}] on ${agent} with model ${model} is denied`, () => {
          const r = decide({ subagent_type: agent, description: `[${category}] Task`, model, prompt: 'x' });
          assert.equal(r.decision, 'deny');
          assert.equal(r.rule, 'downgrade-blocked');
        });
      }
    }
  }
  it('every category/agent pair launched without a model is allowed only at or above its floor', () => {
    for (const [category, c] of Object.entries(policy.categories)) {
      for (const agent of c.agents) {
        const r = decide({ subagent_type: agent, description: `[${category}] Task`, prompt: owned(`scratch/${category}-${agent}.md`) });
        // 'inherit' (session model, unknown to the hook) is only acceptable when the floor is haiku.
        if (r.decision === 'allow' && r.info.requestedModel === 'inherit') assert.equal(c.floor, 'haiku', `${category}/${agent}`);
        else if (r.decision === 'allow') assert.ok(RANK[r.info.requestedModel] >= RANK[c.floor], `${category}/${agent}`);
        else assert.match(r.rule, /downgrade-blocked|ambiguous-model/, `${category}/${agent}`);
      }
    }
  });
  it('an opus-floor task that would inherit the session model must name its model', () => {
    const r = decide({ subagent_type: 'general-purpose', description: '[complex-debug] Race in worker', prompt: 'x' });
    assert.deepEqual([r.decision, r.rule], ['deny', 'ambiguous-model']);
  });
  it('a write-capable haiku delegation that mentions a high-risk term is denied', () => {
    const r = decide({ subagent_type: 'documentation-agent', description: '[docs-format] Tidy schema doc', prompt: owned('docs/architecture/DATABASE_DESIGN.md') });
    assert.deepEqual([r.decision, r.rule], ['deny', 'haiku-high-risk']);
  });
  it('a high-risk task cannot be smuggled through an untagged general-purpose haiku call', () => {
    const r = decide({ subagent_type: 'general-purpose', description: 'Update auth guard', model: 'haiku', prompt: 'Fix the authorization check.' });
    assert.deepEqual([r.decision, r.rule], ['deny', 'haiku-high-risk']);
  });
  it('a category cannot be sent to an agent outside its route', () => {
    const r = decide({ subagent_type: 'quick-inspector', description: '[security] Audit upload auth', prompt: 'x' });
    assert.deepEqual([r.decision, r.rule], ['deny', 'wrong-agent']);
  });
  it('routing agents require a known category tag', () => {
    assert.equal(decide({ subagent_type: 'frontend-engineer', description: 'Add button', prompt: owned('a.tsx') }).rule, 'missing-category');
    assert.equal(decide({ subagent_type: 'frontend-engineer', description: '[ui-stuff] Add button', prompt: owned('a.tsx') }).rule, 'unknown-category');
  });
});

describe('5. escalation rules', () => {
  it('haiku docs task blocked for risk is accepted when escalated to sonnet', () => {
    const blocked = decide({ subagent_type: 'documentation-agent', description: '[docs-format] Document migration steps', prompt: owned('docs/development/SETUP.md') });
    assert.equal(blocked.rule, 'haiku-high-risk');
    const escalated = decide({ subagent_type: 'documentation-agent', description: '[docs-technical] [escalated-from:haiku] Document migration steps', model: 'sonnet', prompt: owned('docs/development/SETUP.md') });
    assert.equal(escalated.decision, 'allow');
    assert.equal(escalated.info.escalatedFrom, 'haiku');
    assert.equal(escalated.info.requestedModel, 'sonnet');
  });
  it('docs-technical without a sonnet model is denied (haiku default below floor)', () => {
    const r = decide({ subagent_type: 'documentation-agent', description: '[docs-technical] Explain job lifecycle', prompt: owned('docs/x.md') });
    assert.equal(r.rule, 'downgrade-blocked');
  });
  it('performance → perf-investigation requires opus on performance-reviewer', () => {
    assert.equal(decide({ subagent_type: 'performance-reviewer', description: '[perf-investigation] [escalated-from:sonnet] Slow render', prompt: 'x' }).rule, 'downgrade-blocked');
    const ok = decide({ subagent_type: 'performance-reviewer', description: '[perf-investigation] [escalated-from:sonnet] Slow render', model: 'opus', prompt: 'x' });
    assert.equal(ok.decision, 'allow');
    assert.equal(ok.info.escalatedFrom, 'sonnet');
  });
  it('sonnet backend task escalated to an opus security review is allowed', () => {
    const r = decide({ subagent_type: 'security-reviewer', description: '[security] [escalated-from:sonnet] Review token guard', prompt: 'Review.' });
    assert.equal(r.decision, 'allow');
  });
});

describe('6. explicit user overrides are respected', () => {
  it('[override:haiku] on a security review runs only after user confirmation (revised: was a silent allow)', () => {
    const r = decide({ subagent_type: 'security-reviewer', description: '[security] [override:haiku] Quick auth check', model: 'haiku', prompt: 'x' });
    assert.deepEqual([r.decision, r.rule, r.info.requestedModel], ['ask', 'override-below-floor', 'haiku']);
  });
  it('[override:opus] upgrades a simple task', () => {
    const r = decide({ subagent_type: 'quick-inspector', description: '[inspect] [override:opus] List modules', model: 'opus', prompt: 'x' });
    assert.deepEqual([r.decision, r.info.requestedModel], ['allow', 'opus']);
  });
  it('an override tag must match the model parameter', () => {
    const r = decide({ subagent_type: 'security-reviewer', description: '[security] [override:haiku] Check', model: 'sonnet', prompt: 'x' });
    assert.equal(r.rule, 'override-mismatch');
  });
  it('per-call model beats agent frontmatter', () => {
    assert.deepEqual(effectiveModel({ callModel: 'opus', frontmatterModel: 'haiku' }), { model: 'opus', source: 'call', raw: 'opus' });
  });
  it('forced mode (sonnet-only) on opus-floor categories requires user confirmation (revised: was a silent allow)', () => {
    const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
    const r = decide({ subagent_type: 'security-reviewer', description: '[security] Review', prompt: 'x' }, { env });
    assert.deepEqual([r.decision, r.rule, r.info.requestedModel], ['ask', 'forced-below-floor', 'sonnet']);
  });
  it('CLAUDE_CODE_SUBAGENT_MODEL without FORCE is only a fallback (verified behaviour)', () => {
    assert.equal(effectiveModel({ frontmatterModel: 'haiku', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }).model, 'haiku');
    assert.equal(effectiveModel({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' } }).source, 'env-default');
  });
  it('mode files force the documented model', () => {
    for (const m of ['opus', 'sonnet']) {
      const mode = JSON.parse(readFileSync(join(ROOT, `.claude/modes/${m}-only.json`), 'utf8'));
      assert.equal(mode.model, m);
      assert.equal(mode.env.CLAUDE_CODE_SUBAGENT_MODEL, m);
      assert.equal(mode.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    }
  });
});

describe('7. unsupported model aliases are handled safely', () => {
  it('normalises aliases and full IDs, rejects others', () => {
    assert.equal(normalizeModel('claude-opus-5-5'), 'opus');
    assert.equal(normalizeModel('claude-haiku-5-5'), 'haiku');
    assert.equal(normalizeModel('sonnet'), 'sonnet');
    for (const bad of ['not-a-model', 'gpt-4o', 'opusplan', '', undefined]) assert.equal(normalizeModel(bad), null);
  });
  it('a delegation with an unknown model is denied, never defaulted', () => {
    const r = decide({ subagent_type: 'quick-inspector', description: '[inspect] x', model: 'not-a-model', prompt: 'x' });
    assert.deepEqual([r.decision, r.rule], ['deny', 'unsupported-model']);
    assert.match(r.reason, /approved alternative/);
    assert.equal(r.info.requestedModel, 'unsupported:not-a-model'); // logged as asked, not as "inherit"
  });
  it('every model named in policy and agents is a supported alias', () => {
    for (const c of Object.values(policy.categories)) assert.ok(RANK[c.tier] && RANK[c.floor] && RANK[c.tier] >= RANK[c.floor]);
    for (const a of Object.values(policy.routingAgents)) assert.ok(RANK[a.model]);
  });
});

describe('8. parallel execution respects file ownership', () => {
  const running = [{ agentType: 'frontend-engineer', agentId: 'a1', owned: ['apps/web/src/components/**'] }];
  it('write-capable routing agents must declare Owned files', () => {
    assert.equal(decide({ subagent_type: 'frontend-engineer', description: '[frontend] Add card', prompt: 'No ownership.' }).rule, 'missing-ownership');
  });
  it('overlapping ownership with a running writer is denied', () => {
    const r = decide({ subagent_type: 'test-engineer', description: '[tests] Card tests', prompt: owned('apps/web/src/components/Card.test.tsx') }, { activeWriters: running });
    assert.deepEqual([r.decision, r.rule], ['deny', 'ownership-conflict']);
  });
  it('disjoint ownership runs in parallel', () => {
    const r = decide({ subagent_type: 'backend-engineer', description: '[backend] Health route', prompt: owned('apps/api/src/health/health.controller.ts') }, { activeWriters: running });
    assert.equal(r.decision, 'allow');
  });
  it('worktree isolation bypasses ownership conflicts', () => {
    const r = decide({ subagent_type: 'test-engineer', description: '[tests] Card tests', isolation: 'worktree', prompt: owned('apps/web/src/components/Card.test.tsx') }, { activeWriters: running });
    assert.equal(r.decision, 'allow');
  });
  it('read-only agents are never blocked by writers', () => {
    const r = decide({ subagent_type: 'security-reviewer', description: '[security] Review card', prompt: 'apps/web/src/components/**' }, { activeWriters: running });
    assert.equal(r.decision, 'allow');
  });
  it('parses comma and bullet ownership lists', () => {
    assert.deepEqual(parseOwnedFiles('Owned files: a.ts, `b/c.ts`'), ['a.ts', 'b/c.ts']);
    assert.deepEqual(parseOwnedFiles('x\nOwned files:\n- a.ts\n- docs/**\n\nmore'), ['a.ts', 'docs/**']);
    assert.deepEqual(parseOwnedFiles('no list'), []);
  });
  it('overlap is conservative', () => {
    assert.ok(pathsOverlap('apps/web/src/**', 'apps/web/src/App.tsx'));
    assert.ok(pathsOverlap('apps/web/src/App*', 'apps/web/src/App.tsx'));
    assert.ok(pathsOverlap('./a/b.ts', 'a/b.ts'));
    assert.ok(pathsOverlap('**', 'anything.ts'));
    assert.ok(!pathsOverlap('apps/web/src/a.ts', 'apps/web/src/ab.ts'));
    assert.ok(!pathsOverlap('apps/api/**', 'apps/web/**'));
  });
});

describe('9. usage reporting does not invent information', () => {
  it('sums usage per model and de-duplicates split messages', () => {
    const line = (o) => JSON.stringify(o);
    const usage = { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 100 };
    const lines = [
      line({ type: 'user', message: { content: 'SYNTHETIC-SECRET-MARKER' } }),
      line({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage } }),
      line({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage } }),
      line({ type: 'assistant', message: { id: 'm2', model: 'claude-haiku-5-5', usage } }),
      'not json',
    ];
    assert.deepEqual(summarizeTranscript(lines), { 'claude-haiku-5-5': { input: 4, output: 10, cacheRead: 20, cacheWrite: 200, apiCalls: 2 } });
  });
  it('returns nothing (not zeros per model) when no usage exists', () => {
    assert.deepEqual(summarizeTranscript([JSON.stringify({ type: 'assistant', message: { content: 'x' } })]), {});
  });
  it('task labels strip tags and are truncated', () => {
    assert.equal(taskLabel('[frontend] [escalated-from:haiku]  Add   card'), 'Add card');
    assert.equal(taskLabel('x'.repeat(200)).length, 80);
    assert.deepEqual(parseTags('[security] [override:haiku] [escalated-from:sonnet] y'), { category: 'security', override: 'haiku', escalatedFrom: 'sonnet', unknownTags: [] });
  });

  const runHook = (payload, dir) =>
    spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, MODEL_ROUTING_USAGE_DIR: dir, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '' }, encoding: 'utf8' });
  const readLog = (dir) => readFileSync(join(dir, 'model-usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('hook logs "unavailable" instead of guessing, and never logs prompts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-'));
    const base = { session_id: 's1', transcript_path: '/nonexistent', tool_name: 'Agent', tool_use_id: 't1' };
    const toolInput = { subagent_type: 'quick-inspector', description: '[inspect] List modules', prompt: 'SYNTHETIC-SECRET-MARKER' };
    assert.equal(runHook({ ...base, hook_event_name: 'PreToolUse', tool_input: toolInput }, dir).stdout, '');
    runHook({ ...base, hook_event_name: 'PostToolUse', tool_input: toolInput, tool_response: {} }, dir);
    runHook({ session_id: 's1', hook_event_name: 'SubagentStop', agent_id: 'a9', agent_type: 'quick-inspector', agent_transcript_path: '/nonexistent' }, dir);
    const [launch, complete] = readLog(dir);
    assert.deepEqual([launch.resolvedModel, launch.status, launch.task], ['unavailable', 'unavailable', 'List modules']);
    assert.equal(complete.models, 'unavailable');
    assert.ok(!readFileSync(join(dir, 'model-usage.jsonl'), 'utf8').includes('SYNTHETIC-SECRET-MARKER'));
  });
  it('hook records the resolved model and real transcript usage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-'));
    const transcript = join(dir, 'agent.jsonl');
    writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'claude-sonnet-5-5', usage: { input_tokens: 3, output_tokens: 7 } } })}\n`);
    const toolInput = { subagent_type: 'frontend-engineer', description: '[frontend] Add card', prompt: owned('apps/web/src/x.tsx') };
    const base = { session_id: 's2', tool_name: 'Agent', tool_use_id: 't2', tool_input: toolInput };
    runHook({ ...base, hook_event_name: 'PreToolUse' }, dir);
    runHook({ ...base, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched', agentId: 'a2', resolvedModel: 'claude-sonnet-5-5' } }, dir);
    // A second writer on the same file is blocked while the first runs...
    const clash = runHook({ ...base, tool_use_id: 't3', hook_event_name: 'PreToolUse' }, dir);
    assert.match(clash.stdout, /ownership-conflict|overlaps/);
    runHook({ session_id: 's2', hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'frontend-engineer', agent_transcript_path: transcript }, dir);
    // ...and allowed once it has stopped.
    assert.equal(runHook({ ...base, tool_use_id: 't4', hook_event_name: 'PreToolUse' }, dir).stdout, '');
    const log = readLog(dir);
    const launch = log.find((r) => r.event === 'launch');
    assert.equal(launch.resolvedModel, 'claude-sonnet-5-5');
    assert.deepEqual(log.find((r) => r.event === 'complete').models, { 'claude-sonnet-5-5': { input: 3, output: 7, cacheRead: 0, cacheWrite: 0, apiCalls: 1 } });
    assert.equal(log.find((r) => r.event === 'blocked').rule, 'ownership-conflict');
  });
  it('hook emits a deny decision Claude Code understands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'routing-'));
    const out = runHook({ session_id: 's3', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't', tool_input: { subagent_type: 'security-reviewer', description: '[security] x', model: 'haiku', prompt: 'x' } }, dir);
    const d = JSON.parse(out.stdout).hookSpecificOutput;
    assert.deepEqual([d.hookEventName, d.permissionDecision], ['PreToolUse', 'deny']);
    assert.match(d.permissionDecisionReason, /floor opus/);
  });
});

describe('10. existing project instructions remain respected', () => {
  const agentsDir = join(ROOT, '.claude/agents');
  const text = (name) => readFileSync(join(agentsDir, `${name}.md`), 'utf8');
  it('every routing agent exists with the policy model and a description', () => {
    for (const [name, a] of Object.entries(policy.routingAgents)) {
      const d = def(name);
      assert.ok(d, `${name} missing`);
      assert.equal(d.model, a.model, name);
      assert.match(text(name), /^description: .{40,}/m, name);
    }
  });
  it('every category routes only to existing agents', () => {
    const project = readdirSync(agentsDir).map((f) => f.replace(/\.md$/, ''));
    for (const [c, cat] of Object.entries(policy.categories)) for (const a of cat.agents) assert.ok(project.includes(a) || policy.builtinAgents[a], `${c} → ${a}`);
  });
  it('read-only agents have no write tools (performance-reviewer: Bash for measurement only)', () => {
    for (const [name, a] of Object.entries(policy.routingAgents)) {
      if (a.writes) continue;
      const tools = def(name).tools;
      assert.ok(tools, `${name} must list tools`);
      const writeTools = tools.filter((t) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'].includes(t));
      assert.deepEqual(writeTools, name === 'performance-reviewer' ? ['Bash'] : [], name);
    }
  });
  it('every routing agent defines scope, escalation and an output contract', () => {
    for (const name of Object.keys(policy.routingAgents)) {
      const t = text(name);
      assert.match(t, /Escalate/, name);
      assert.match(t, /STATUS:/, name);
      assert.match(t, /ESCALATION:/, name);
    }
  });
  it('write-capable agents forbid commits, dependency changes and test weakening, and require ownership', () => {
    for (const [name, a] of Object.entries(policy.routingAgents)) {
      if (!a.writes || name === 'documentation-agent') continue;
      const t = text(name);
      assert.match(t, /Commit or push/, name);
      assert.match(t, /dependenc/i, name);
      assert.match(t, /loosen/, name);
      assert.match(t, /Owned files:/, name);
    }
    assert.match(text('documentation-agent'), /docs\/architecture\/adr/);
    assert.match(text('documentation-agent'), /Owned files:/);
  });
  it('settings keep the secret/storage deny rules and wire the routing hook', () => {
    const s = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8'));
    for (const rule of ['Read(./**/.env)', 'Read(./**/*.key)', 'Read(./storage/**)', 'Edit(./**/.env)']) assert.ok(s.permissions.deny.includes(rule), rule);
    assert.ok(s.permissions.ask.includes('Bash(git push:*)'));
    for (const ev of ['PreToolUse', 'PostToolUse', 'SubagentStop']) assert.match(JSON.stringify(s.hooks[ev]), /model-routing\.mjs/, ev);
  });
  it('CLAUDE.md activates the router and the usage log is gitignored', () => {
    assert.match(readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8'), /model-router/);
    assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^\.claude\/usage\/$/m);
  });
});

describe('11. revised risk floor and override behaviour (regression)', () => {
  const SONNET_ONLY = { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
  const OPUS_ONLY = { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
  const opusFloor = Object.entries(policy.categories).filter(([, c]) => c.floor === 'opus');

  describe('explicit overrides below the floor warn and require confirmation', () => {
    for (const [category, c] of opusFloor) {
      for (const agent of c.agents) {
        for (const model of ['haiku', 'sonnet']) {
          it(`[${category}] [override:${model}] on ${agent} → ask, never allow`, () => {
            const r = decide({ subagent_type: agent, description: `[${category}] [override:${model}] Task`, model, prompt: 'x' });
            assert.deepEqual([r.decision, r.rule], ['ask', 'override-below-floor']);
            assert.match(r.reason, /⚠ model-router: BELOW REQUIRED MODEL TIER \(explicit override/);
            assert.deepEqual(r.info.belowFloor, ['downgrade-blocked']);
          });
        }
      }
    }
    it('an override at or above the floor needs no confirmation', () => {
      assert.equal(decide({ subagent_type: 'quick-inspector', description: '[inspect] [override:opus] x', model: 'opus', prompt: 'x' }).decision, 'allow');
      assert.equal(decide({ subagent_type: 'security-reviewer', description: '[security] [override:opus] x', model: 'opus', prompt: 'x' }).decision, 'allow');
      assert.equal(decide({ subagent_type: 'frontend-engineer', description: '[frontend] [override:sonnet] x', model: 'sonnet', prompt: owned('apps/web/a.tsx') }).decision, 'allow');
    });
    it('[override:haiku] on a write-capable high-risk doc edit → ask', () => {
      const r = decide({ subagent_type: 'documentation-agent', description: '[docs-format] [override:haiku] Tidy', model: 'haiku', prompt: owned('docs/x.md') + 'reword the migration notes' });
      assert.deepEqual([r.decision, r.info.belowFloor], ['ask', ['haiku-high-risk']]);
    });
    it('[override:sonnet] on backend work that mentions provenance → ask', () => {
      const r = decide({ subagent_type: 'backend-engineer', description: '[backend] [override:sonnet] Report fields', model: 'sonnet', prompt: owned('apps/api/src/r.ts') + 'add provenance fields' });
      assert.deepEqual([r.decision, r.info.belowFloor], ['ask', ['high-risk-signal']]);
    });
    it('the override tag still has to match the model parameter', () => {
      assert.equal(decide({ subagent_type: 'security-reviewer', description: '[security] [override:haiku] x', prompt: 'x' }).rule, 'override-mismatch');
    });
  });

  describe('sonnet-only mode does not bypass safeguards', () => {
    for (const [category, c] of opusFloor) {
      for (const agent of c.agents) {
        it(`sonnet-only: [${category}] on ${agent} → ask`, () => {
          const r = decide({ subagent_type: agent, description: `[${category}] Task`, prompt: 'x' }, { env: SONNET_ONLY });
          assert.deepEqual([r.decision, r.rule, r.info.requestedModel], ['ask', 'forced-below-floor', 'sonnet']);
          assert.match(r.reason, /forced sonnet-only mode/);
        });
      }
    }
    it('sonnet-only still requires a category tag and the right agent', () => {
      assert.equal(decide({ subagent_type: 'security-reviewer', description: 'Review', prompt: 'x' }, { env: SONNET_ONLY }).rule, 'missing-category');
      assert.equal(decide({ subagent_type: 'quick-inspector', description: '[security] x', prompt: 'x' }, { env: SONNET_ONLY }).rule, 'wrong-agent');
    });
    it('sonnet-only still asks on Opus-domain terms in sonnet categories', () => {
      const r = decide({ subagent_type: 'backend-engineer', description: '[backend] Add table', prompt: owned('packages/db/x.ts') + 'write the drizzle migration' }, { env: SONNET_ONLY });
      assert.deepEqual([r.decision, r.info.belowFloor], ['ask', ['high-risk-signal']]);
    });
    it('sonnet-only routine work runs without prompts', () => {
      assert.equal(decide({ subagent_type: 'frontend-engineer', description: '[frontend] Card', prompt: owned('apps/web/a.tsx') }, { env: SONNET_ONLY }).decision, 'allow');
    });
    it('ownership conflicts are denied even in forced mode (deny beats ask)', () => {
      const running = [{ agentType: 'frontend-engineer', agentId: 'a1', owned: ['apps/web/**'] }];
      const r = decide({ subagent_type: 'test-engineer', description: '[tests] x', prompt: owned('apps/web/a.test.tsx') }, { env: SONNET_ONLY, activeWriters: running });
      assert.equal(r.rule, 'ownership-conflict');
    });
    it('opus-only mode never needs confirmation for opus-floor work', () => {
      for (const [category, c] of opusFloor) {
        const r = decide({ subagent_type: c.agents[0], description: `[${category}] Task`, prompt: owned('x.md') }, { env: OPUS_ONLY });
        assert.deepEqual([r.decision, r.rule], ['allow', 'forced-mode'], category);
      }
    });
  });

  describe('opus-domain work cannot run silently below Opus via a sonnet category', () => {
    const areas = { security: 'fix the security headers', architecture: 'change the architecture of the queue', 'data integrity': 'make transcript versions immutable', migrations: 'add a migration', provenance: 'store provenance per assertion' };
    for (const [area, text] of Object.entries(areas)) {
      it(`${area}: sonnet backend delegation is denied (high-risk-signal)`, () => {
        const r = decide({ subagent_type: 'backend-engineer', description: '[backend] Change', prompt: owned('apps/api/src/x.ts') + text });
        assert.deepEqual([r.decision, r.rule], ['deny', 'high-risk-signal']);
        assert.match(r.reason, /Opus category|opus-review-follows/);
      });
    }
    it('a sonnet code review of auth code is denied (reviews are in scope even though read-only)', () => {
      const r = decide({ subagent_type: 'general-purpose', description: '[code-review] Review guard', model: 'sonnet', prompt: 'Review the authorization guard.' });
      assert.equal(r.rule, 'high-risk-signal');
    });
    it('sonnet planning of a migration is denied', () => {
      assert.equal(decide({ subagent_type: 'Plan', description: '[planning] Plan change', model: 'sonnet', prompt: 'Plan the schema migration.' }).rule, 'high-risk-signal');
    });
    it('[opus-review-follows] allows Sonnet implementation under an Opus plan, and is recorded', () => {
      const r = decide({ subagent_type: 'backend-engineer', description: '[backend] [opus-review-follows] Migration impl', prompt: owned('packages/db/x.ts') + 'implement the approved migration' });
      assert.equal(r.decision, 'allow');
      assert.equal(r.info.opusReviewFollows, true);
    });
    it('untagged write-capable sonnet delegation on schema work is denied', () => {
      assert.equal(decide({ subagent_type: 'general-purpose', description: 'Tweak schema', model: 'sonnet', prompt: 'edit the schema' }).rule, 'high-risk-signal');
    });
    it('exempt: haiku inspection, technical docs, Opus delegations, read-only test planning', () => {
      assert.equal(decide({ subagent_type: 'quick-inspector', description: '[inspect] Find migrations', prompt: 'find migration files' }).decision, 'allow');
      assert.equal(decide({ subagent_type: 'documentation-agent', description: '[docs-technical] Doc', model: 'sonnet', prompt: owned('docs/x.md') + 'document the migration flow' }).decision, 'allow');
      assert.equal(decide({ subagent_type: 'general-purpose', description: '[complex-debug] Race', model: 'opus', prompt: 'race condition in worker' }).decision, 'allow');
      assert.equal(decide({ subagent_type: 'test-strategist', description: 'Plan auth tests', prompt: 'plan security tests' }).decision, 'allow');
    });
  });

  describe('missing Opus reviews are reported', () => {
    const impl = { session: 's', agentType: 'backend-engineer', category: 'backend', task: 'impl', requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5-5', opusReviewFollows: true };
    const opusReview = { session: 's', agentType: 'security-reviewer', category: 'data-integrity', requestedModel: 'opus', resolvedModel: 'claude-opus-5-5' };
    it('flags tagged work with no later Opus review', () => assert.equal(missingOpusReviews([impl], policy).length, 1));
    it('a later Opus-floor review on opus clears it', () => assert.equal(missingOpusReviews([impl, opusReview], policy).length, 0));
    it('a review that ran on sonnet (confirmed override) does not clear it', () => {
      assert.equal(missingOpusReviews([impl, { ...opusReview, requestedModel: 'sonnet', resolvedModel: 'claude-sonnet-5-5' }], policy).length, 1);
    });
    it('an earlier review or another session does not clear it', () => {
      assert.equal(missingOpusReviews([opusReview, impl], policy).length, 1);
      assert.equal(missingOpusReviews([impl, { ...opusReview, session: 'other' }], policy).length, 1);
    });
  });

  describe('hook protocol and logging for confirmations', () => {
    const runHook = (payload, dir, env = {}) =>
      spawnSync(process.execPath, [HOOK, ...(payload ? [] : ['report'])], { input: payload ? JSON.stringify(payload) : '', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, MODEL_ROUTING_USAGE_DIR: dir, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '', ...env }, encoding: 'utf8' });
    it('emits permissionDecision "ask" with the warning, logs it, and reports confirmed vs declined', () => {
      const dir = mkdtempSync(join(tmpdir(), 'routing-'));
      const base = { session_id: 's9', tool_name: 'Agent', transcript_path: '/nonexistent' };
      const confirmed = { subagent_type: 'security-reviewer', description: '[security] [override:sonnet] Review', model: 'sonnet', prompt: 'x' };
      const declined = { ...confirmed, description: '[data-integrity] [override:haiku] Review', model: 'haiku' };
      const out = JSON.parse(runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'c1', tool_input: confirmed }, dir).stdout).hookSpecificOutput;
      assert.deepEqual([out.hookEventName, out.permissionDecision], ['PreToolUse', 'ask']);
      assert.match(out.permissionDecisionReason, /BELOW REQUIRED MODEL TIER/);
      runHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 'c1', tool_input: confirmed, tool_response: { status: 'async_launched', agentId: 'a1', resolvedModel: 'claude-sonnet-5-5' } }, dir);
      runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'd1', tool_input: declined }, dir);
      const log = readFileSync(join(dir, 'model-usage.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(log.filter((r) => r.event === 'confirm-requested').length, 2);
      assert.deepEqual(log.find((r) => r.event === 'launch').belowFloor, ['downgrade-blocked']);
      const report = runHook(null, dir).stdout;
      assert.match(report, /security-reviewer \[security\] on sonnet: override-below-floor .*CONFIRMED and ran/);
      assert.match(report, /security-reviewer \[data-integrity\] on haiku: override-below-floor .*not launched/);
    });
    it('a declined ask leaves no ownership lock; a confirmed writer is registered after launch', () => {
      const dir = mkdtempSync(join(tmpdir(), 'routing-'));
      const base = { session_id: 's10', tool_name: 'Agent' };
      const writer = { subagent_type: 'backend-engineer', description: '[backend] [override:sonnet] Prov', model: 'sonnet', prompt: owned('apps/api/src/p.ts') + 'provenance' };
      const other = { subagent_type: 'test-engineer', description: '[tests] P tests', prompt: owned('apps/api/src/p.ts') };
      assert.match(runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'w1', tool_input: writer }, dir).stdout, /"ask"/);
      // Declined: no PostToolUse. The other writer is not blocked by a phantom lock.
      assert.equal(runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'o1', tool_input: other }, dir).stdout, '');
      // Simulate a later confirmed launch of the same kind of writer (o1 never launched; clear it).
      runHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 'o1', tool_input: other, tool_response: { status: 'completed' } }, dir);
      runHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 'w2', tool_input: writer, tool_response: { status: 'async_launched', agentId: 'aw2', resolvedModel: 'claude-sonnet-5-5' } }, dir);
      assert.match(runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'o2', tool_input: other }, dir).stdout, /ownership-conflict|overlaps/);
    });
  });

  it('test-strategist has an explicit sonnet model and stays read-only', () => {
    const d = def('test-strategist');
    assert.equal(d.model, 'sonnet');
    assert.deepEqual(d.tools, ['Read', 'Grep', 'Glob']);
  });
});
