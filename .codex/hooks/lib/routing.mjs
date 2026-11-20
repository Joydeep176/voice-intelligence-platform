// Pure model-routing logic used by ../model-routing.mjs (hook entry) and ../tests.
// No I/O except readAgentDefinition. Policy: .claude/skills/model-router/routing-policy.json.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RANK = { haiku: 1, sonnet: 2, opus: 3 };
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash'];
const TAG = /\[([a-z][a-z0-9-]*)(?::([a-z0-9.-]+))?\]/gi;

/** Map an alias or full model ID (e.g. claude-opus-5-5) to haiku|sonnet|opus, else null. */
export function normalizeModel(value) {
  if (!value || typeof value !== 'string') return null;
  const v = value.toLowerCase();
  return Object.keys(RANK).find((m) => v === m || v.includes(`-${m}-`) || v.startsWith(`${m}-`)) ?? null;
}

/** Parse `[category]`, `[override:<model>]` and `[escalated-from:<model>]` tags from a description. */
export function parseTags(description = '') {
  // `opusReviewFollows` is set only when `[opus-review-follows]` is present.
  const tags = { category: null, override: null, escalatedFrom: null, unknownTags: [] };
  for (const [, name, value] of description.matchAll(TAG)) {
    const key = name.toLowerCase();
    if (key === 'opus-review-follows' && !value) tags.opusReviewFollows = true;
    else if (key === 'override' && value) tags.override = value.toLowerCase();
    else if (key === 'escalated-from' && value) tags.escalatedFrom = value.toLowerCase();
    else if (!value && !tags.category) tags.category = key;
    else tags.unknownTags.push(key);
  }
  return tags;
}

/** Short task label for logs: tags stripped, whitespace collapsed, max 80 chars. Never the prompt. */
export function taskLabel(description = '') {
  return description.replace(TAG, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Read model and tools from `.claude/agents/<type>.md` frontmatter. Returns null if not a project agent. */
export function readAgentDefinition(projectDir, agentType) {
  if (!agentType || !/^[A-Za-z0-9_-]+$/.test(agentType)) return null;
  const file = join(projectDir, '.claude', 'agents', `${agentType}.md`);
  if (!existsSync(file)) return null;
  const match = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const field = (name) => match[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim() ?? null;
  const tools = field('tools');
  return {
    model: field('model'),
    tools: tools ? tools.split(',').map((t) => t.trim()) : null,
  };
}

/** Whether a delegation can modify files. Unknown agents are assumed write-capable (conservative). */
export function canWrite(agentType, policy, definition) {
  if (policy.routingAgents[agentType]) return policy.routingAgents[agentType].writes;
  if (policy.builtinAgents[agentType]) return policy.builtinAgents[agentType].writes;
  if (definition?.tools) return definition.tools.some((t) => WRITE_TOOLS.includes(t));
  return true;
}

/**
 * Model the subagent will run on, following the precedence verified on Claude Code 2.1.329:
 * forced env > per-call `model` > agent frontmatter > CLAUDE_CODE_SUBAGENT_MODEL fallback > inherit.
 */
export function effectiveModel({ callModel, frontmatterModel, env = {} }) {
  const forced = normalizeModel(env.CLAUDE_CODE_SUBAGENT_MODEL);
  if (env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE && !/^(0|false)?$/i.test(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE) && forced) {
    return { model: forced, source: 'forced-mode' };
  }
  if (callModel) return { model: normalizeModel(callModel), source: 'call', raw: callModel };
  const fm = normalizeModel(frontmatterModel);
  if (fm) return { model: fm, source: 'frontmatter' };
  if (forced) return { model: forced, source: 'env-default' };
  return { model: null, source: 'inherit' };
}

/** Paths listed after an `Owned files:` line in a prompt (comma- or newline/bullet-separated). */
export function parseOwnedFiles(prompt = '') {
  const m = prompt.match(/^Owned files:[ \t]*(.*(?:\n[ \t]*[-*][ \t]+.*)*)/im);
  if (!m) return [];
  return m[1]
    .split(/[\n,]/)
    .map((p) => p.replace(/^[ \t]*[-*][ \t]+/, '').replace(/`/g, '').trim())
    .filter((p) => p && !/^none$/i.test(p));
}

/** Conservative overlap: compares the literal prefix before any glob character, by path segment. */
export function pathsOverlap(a, b) {
  const GLOB = /[*?[{]/;
  const prefix = (p) => p.replace(/^\.\//, '').split(GLOB)[0];
  const x = prefix(a).replace(/\/+$/, '');
  const y = prefix(b).replace(/\/+$/, '');
  if (x === '' || y === '') return true;
  if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
  // A glob with a partial final segment, e.g. `src/App*` vs `src/App.tsx`.
  return (GLOB.test(a) && y.startsWith(prefix(a))) || (GLOB.test(b) && x.startsWith(prefix(b)));
}

/**
 * Model-tier violations for a delegation: below the category floor, write-capable haiku on
 * high-risk terms, or a sub-opus delegation that mentions an Opus-domain term (security,
 * architecture, data integrity, migrations, provenance) outside an Opus category.
 */
function tierViolations({ toolInput, policy, tags, knownCategory, agentType, eff, writes }) {
  const violations = [];
  const floor = knownCategory ? policy.categories[knownCategory].floor : null;
  const text = `${toolInput.description ?? ''}\n${toolInput.prompt ?? ''}`.toLowerCase();
  if (floor && eff.model && RANK[eff.model] < RANK[floor]) {
    violations.push({ rule: 'downgrade-blocked', message: `category "${knownCategory}" has floor ${floor}; ${agentType} would run on ${eff.model}` });
  }
  if (eff.model === 'haiku' && writes) {
    const hit = policy.highRiskTerms.find((t) => text.includes(t));
    if (hit) violations.push({ rule: 'haiku-high-risk', message: `a write-capable haiku delegation mentions high-risk term "${hit}"` });
  }
  const inSignalScope =
    !violations.length &&
    eff.model &&
    RANK[eff.model] < RANK.opus &&
    !policy.signalExemptCategories.includes(knownCategory) &&
    (writes || policy.reviewCategories.includes(knownCategory)) &&
    !tags.opusReviewFollows;
  if (inSignalScope) {
    const hit = policy.opusDomainTerms.find((t) => text.includes(t));
    if (hit) violations.push({ rule: 'high-risk-signal', message: `${eff.model} delegation mentions "${hit}" (security / architecture / data-integrity domain) outside an Opus category` });
  }
  return violations;
}

/**
 * Decide whether an Agent delegation may launch.
 * - deny:  policy violation; the coordinator must fix the call.
 * - ask:   below the required tier, but the user explicitly chose it ([override:X] or a forced
 *          mode). Claude Code shows the warning and waits for the user's confirmation.
 * - allow: within policy.
 * @returns {{ decision: 'allow'|'ask'|'deny', rule: string, reason?: string, info: object }}
 */
export function evaluateDelegation({ toolInput, policy, definition, env = {}, activeWriters = [] }) {
  const agentType = toolInput.subagent_type ?? 'general-purpose';
  const tags = parseTags(toolInput.description);
  const knownCategory = tags.category && policy.categories[tags.category] ? tags.category : null;
  const isRoutingAgent = Boolean(policy.routingAgents[agentType]);
  const eff = effectiveModel({ callModel: toolInput.model, frontmatterModel: definition?.model, env });
  const writes = canWrite(agentType, policy, definition);
  const owned = parseOwnedFiles(toolInput.prompt);
  const info = {
    agentType,
    category: knownCategory ?? (tags.category ? `unknown:${tags.category}` : 'untagged'),
    requestedModel: eff.model ?? (eff.raw ? `unsupported:${eff.raw}` : 'inherit'),
    modelSource: eff.source,
    override: tags.override,
    escalatedFrom: tags.escalatedFrom,
    forced: eff.source === 'forced-mode',
    opusReviewFollows: Boolean(tags.opusReviewFollows),
    belowFloor: [],
    writes,
    owned,
  };
  const deny = (rule, reason) => ({ decision: 'deny', rule, reason: `model-router: ${reason}`, info });

  if (toolInput.model && !normalizeModel(toolInput.model)) {
    return deny('unsupported-model', `model "${toolInput.model}" is not one of ${policy.models.join(', ')}. Ask the user for an approved alternative.`);
  }

  // Category checks apply in every mode, including forced modes, so floors are always known.
  if (isRoutingAgent && !tags.category) {
    return deny('missing-category', `delegations to ${agentType} need a category tag in the description, e.g. "[${Object.keys(policy.categories).find((c) => policy.categories[c].agents.includes(agentType))}] <task>". See the model-router skill.`);
  }
  if (tags.category && !knownCategory && isRoutingAgent) {
    return deny('unknown-category', `unknown category "${tags.category}". Valid: ${Object.keys(policy.categories).join(', ')}.`);
  }
  if (knownCategory && !policy.categories[knownCategory].agents.includes(agentType)) {
    return deny('wrong-agent', `category "${knownCategory}" routes to ${policy.categories[knownCategory].agents.join(' or ')}, not ${agentType}.`);
  }
  if (tags.override && (!RANK[tags.override] || normalizeModel(toolInput.model) !== tags.override)) {
    return deny('override-mismatch', `[override:${tags.override}] must be paired with the Agent model parameter "${tags.override}". Use it only when the user explicitly chose that model.`);
  }
  const floor = knownCategory ? policy.categories[knownCategory].floor : null;
  if (floor && RANK[floor] > RANK.haiku && !eff.model) {
    return deny('ambiguous-model', `category "${knownCategory}" requires at least ${floor}, but ${agentType} would inherit the session model. Pass model "${policy.categories[knownCategory].tier}" explicitly.`);
  }

  const violations = tierViolations({ toolInput, policy, tags, knownCategory, agentType, eff, writes });
  info.belowFloor = violations.map((v) => v.rule);
  const userChose = Boolean(tags.override) || info.forced;
  if (violations.length && !userChose) {
    const [v] = violations;
    const fix = {
      'downgrade-blocked': `Pass model "${floor}" (escalate), or ask the user to override.`,
      'haiku-high-risk': 'Escalate to sonnet ("[escalated-from:haiku]") or re-scope.',
      'high-risk-signal': 'Use the matching Opus category (security / architecture / data-integrity), or, if this is Sonnet implementation under an Opus plan, add [opus-review-follows] and run an Opus review afterwards.',
    }[v.rule];
    return deny(v.rule, `${v.message}. ${fix}`);
  }

  if (writes && toolInput.isolation !== 'worktree') {
    if (isRoutingAgent && owned.length === 0) {
      return deny('missing-ownership', `write-capable ${agentType} needs an "Owned files:" line listing the paths it may modify (or isolation "worktree").`);
    }
    for (const w of activeWriters) {
      const clash = owned.find((p) => w.owned.some((q) => pathsOverlap(p, q)));
      if (clash) {
        return deny('ownership-conflict', `"${clash}" overlaps files owned by running ${w.agentType} (${w.agentId ?? w.toolUseId}). Wait for it to finish, split ownership, or use isolation "worktree".`);
      }
    }
  }

  if (violations.length) {
    const source = tags.override ? `explicit override to ${tags.override}` : `forced ${eff.model}-only mode`;
    return {
      decision: 'ask',
      rule: tags.override ? 'override-below-floor' : 'forced-below-floor',
      reason: `⚠ model-router: BELOW REQUIRED MODEL TIER (${source}). ${violations.map((v) => v.message).join('; ')}. Approve only if you accept running this on ${eff.model}; deny to keep the policy tier.`,
      info,
    };
  }
  return { decision: 'allow', rule: info.override ? 'user-override' : info.forced ? 'forced-mode' : 'policy', info };
}

/**
 * Launches tagged [opus-review-follows] with no later Opus-floor review (opus model, opus-floor
 * category) in the same session. Records are in log order.
 */
export function missingOpusReviews(launches, policy) {
  return launches.filter((l, i) =>
    l.opusReviewFollows &&
    !launches.slice(i + 1).some((r) =>
      r.session === l.session &&
      policy.categories[r.category]?.floor === 'opus' &&
      normalizeModel(r.resolvedModel !== 'unavailable' ? r.resolvedModel : r.requestedModel) === 'opus'),
  );
}

/** Sum token usage per model from transcript JSONL lines, de-duplicated by API message id. */
export function summarizeTranscript(lines, { sidechain } = {}) {
  const byMessage = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (entry.type !== 'assistant' || !msg?.usage || !msg.model) continue;
    if (sidechain !== undefined && Boolean(entry.isSidechain) !== sidechain) continue;
    byMessage.set(msg.id ?? entry.uuid, { model: msg.model, usage: msg.usage });
  }
  const models = {};
  for (const { model, usage } of byMessage.values()) {
    const m = (models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0 });
    m.input += usage.input_tokens ?? 0;
    m.output += usage.output_tokens ?? 0;
    m.cacheRead += usage.cache_read_input_tokens ?? 0;
    m.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    m.apiCalls += 1;
  }
  return models;
}
