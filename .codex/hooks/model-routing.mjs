#!/usr/bin/env node
// Model-routing hook and usage report. See docs/development/MODEL_ROUTING.md.
//
// Hook mode (stdin = Claude Code hook JSON), wired in .claude/settings.json:
//   PreToolUse(Agent)  -> enforce routing policy (deny with a reason, or allow)
//   PostToolUse(Agent) -> log the launch with the model Claude Code actually resolved
//   SubagentStop       -> log per-model token usage read from the subagent transcript
// CLI mode:
//   node .claude/hooks/model-routing.mjs report [--session <id>] [--all]
//   node .claude/hooks/model-routing.mjs reset-writers
//
// Logs hold IDs, agent types, categories, models, short task labels and token counts only:
// never prompts, file contents or transcript text. Location: .claude/usage/ (gitignored).

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateDelegation, missingOpusReviews, readAgentDefinition, summarizeTranscript, taskLabel } from './lib/routing.mjs';

const POLICY_PATH = fileURLToPath(new URL('../skills/model-router/routing-policy.json', import.meta.url));
const WRITER_TTL_MS = 90 * 60 * 1000;

const projectDir = (input) => process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
const usageDir = (input) => process.env.MODEL_ROUTING_USAGE_DIR || join(projectDir(input), '.claude', 'usage');
const loadPolicy = () => JSON.parse(readFileSync(POLICY_PATH, 'utf8'));

function appendLog(dir, record) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'model-usage.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

// Active write-capable delegations, shared by parallel hook processes. Guarded by an O_EXCL lock file.
function withWriters(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, 'active-writers.lock');
  const file = join(dir, 'active-writers.json');
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      if (Date.now() > deadline) rmSync(lock, { force: true }); // stale lock
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { writers: [], stopped: [] };
    state.writers = state.writers.filter((w) => Date.now() - Date.parse(w.ts) < WRITER_TTL_MS);
    const result = fn(state);
    state.stopped = state.stopped.slice(-50);
    writeFileSync(file, JSON.stringify(state));
    return result;
  } finally {
    rmSync(lock, { force: true });
  }
}

function onPreToolUse(input) {
  const policy = loadPolicy();
  const toolInput = input.tool_input ?? {};
  const definition = readAgentDefinition(projectDir(input), toolInput.subagent_type);
  const dir = usageDir(input);
  const result = withWriters(dir, (state) => {
    const activeWriters = state.writers.filter((w) => w.session === input.session_id);
    const r = evaluateDelegation({ toolInput, policy, definition, env: process.env, activeWriters });
    if (r.decision === 'allow' && r.info.writes && r.info.owned.length && toolInput.isolation !== 'worktree') {
      state.writers.push({ session: input.session_id, toolUseId: input.tool_use_id, agentType: r.info.agentType, owned: r.info.owned, ts: new Date().toISOString() });
    }
    return r;
  });
  const { owned, writes, ...info } = result.info;
  if (result.decision === 'allow') return;
  // deny: policy violation. ask: below-tier run the user chose; Claude Code asks them to confirm.
  appendLog(dir, { event: result.decision === 'deny' ? 'blocked' : 'confirm-requested', session: input.session_id, toolUseId: input.tool_use_id, rule: result.rule, ...info });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: result.decision, permissionDecisionReason: result.reason } }));
}

function onPostToolUse(input) {
  const toolInput = input.tool_input ?? {};
  const res = input.tool_response ?? {};
  const dir = usageDir(input);
  const policy = loadPolicy();
  const definition = readAgentDefinition(projectDir(input), toolInput.subagent_type);
  const { info } = evaluateDelegation({ toolInput, policy, definition, env: process.env });
  withWriters(dir, (state) => {
    const w = state.writers.find((x) => x.toolUseId === input.tool_use_id);
    if (!w) {
      // User-confirmed ("ask") writers are registered only once they have actually launched.
      if (info.writes && info.owned.length && toolInput.isolation !== 'worktree' && res.status === 'async_launched' && !state.stopped.includes(res.agentId)) {
        state.writers.push({ session: input.session_id, toolUseId: input.tool_use_id, agentId: res.agentId, agentType: info.agentType, owned: info.owned, ts: new Date().toISOString() });
      }
      return;
    }
    if (res.status !== 'async_launched' || state.stopped.includes(res.agentId)) state.writers = state.writers.filter((x) => x !== w);
    else w.agentId = res.agentId;
  });
  appendLog(dir, {
    event: 'launch',
    session: input.session_id,
    transcript: input.transcript_path,
    toolUseId: input.tool_use_id,
    agentId: res.agentId ?? null,
    agentType: info.agentType,
    category: info.category,
    task: taskLabel(toolInput.description),
    requestedModel: info.requestedModel,
    modelSource: info.modelSource,
    resolvedModel: res.resolvedModel ?? 'unavailable',
    override: info.override,
    forced: info.forced,
    escalatedFrom: info.escalatedFrom,
    belowFloor: info.belowFloor, // non-empty only for runs the user confirmed below the policy tier
    opusReviewFollows: info.opusReviewFollows,
    status: res.status ?? 'unavailable',
  });
}

function onSubagentStop(input) {
  const dir = usageDir(input);
  withWriters(dir, (state) => {
    state.writers = state.writers.filter((w) => w.agentId !== input.agent_id);
    state.stopped.push(input.agent_id);
  });
  let models = 'unavailable';
  const path = input.agent_transcript_path;
  if (path && existsSync(path)) models = summarizeTranscript(readFileSync(path, 'utf8').split('\n'));
  appendLog(dir, { event: 'complete', session: input.session_id, agentId: input.agent_id, agentType: input.agent_type, status: 'stopped', models });
}

// ---------- CLI ----------

function fmt(n) {
  return n.toLocaleString('en-US');
}

function report(args) {
  const dir = usageDir();
  const file = join(dir, 'model-usage.jsonl');
  if (!existsSync(file)) {
    console.log(`No usage log yet (${file}).`);
    return;
  }
  let records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const sessions = [...new Set(records.map((r) => r.session).filter(Boolean))];
  const sessionArg = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
  if (!args.includes('--all')) {
    const target = sessionArg ?? sessions.at(-1);
    records = records.filter((r) => r.session === target);
    console.log(`Session ${target} (use --all for every session, --session <id> for one)\n`);
  }
  const launches = records.filter((r) => r.event === 'launch');
  const completes = new Map(records.filter((r) => r.event === 'complete').map((r) => [r.agentId, r]));
  const blocked = records.filter((r) => r.event === 'blocked');

  console.log('Delegations');
  console.log('  agent                 category            requested -> resolved         status     tokens in/out (subagent)');
  const totals = {};
  for (const l of launches) {
    const c = completes.get(l.agentId);
    let tokens = 'unavailable (no SubagentStop record)';
    if (c && typeof c.models === 'object') {
      const t = Object.values(c.models).reduce((a, m) => [a[0] + m.input + m.cacheRead + m.cacheWrite, a[1] + m.output], [0, 0]);
      tokens = `${fmt(t[0])} / ${fmt(t[1])}`;
      for (const [model, m] of Object.entries(c.models)) {
        const s = (totals[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, apiCalls: 0 });
        for (const k of Object.keys(s)) s[k] += m[k];
      }
    }
    const flags = [l.override && `override:${l.override}`, l.forced && 'forced-mode', l.escalatedFrom && `escalated-from:${l.escalatedFrom}`].filter(Boolean).join(' ');
    console.log(`  ${l.agentType.padEnd(21)} ${l.category.padEnd(19)} ${`${l.requestedModel} -> ${l.resolvedModel}`.padEnd(29)} ${String(l.status).padEnd(10)} ${tokens}${flags ? `  [${flags}]` : ''}`);
  }
  if (!launches.length) console.log('  (none)');

  console.log('\nBlocked by guard');
  for (const b of blocked) console.log(`  ${b.agentType} [${b.category}] ${b.requestedModel}: ${b.rule}`);
  if (!blocked.length) console.log('  (none)');

  const asks = records.filter((r) => r.event === 'confirm-requested');
  console.log('\n⚠ Below required model tier (user confirmation requested)');
  for (const a of asks) {
    const ran = launches.some((l) => l.toolUseId === a.toolUseId);
    console.log(`  ${a.agentType} [${a.category}] on ${a.requestedModel}: ${a.rule} (${a.belowFloor.join(', ')}) -> ${ran ? 'CONFIRMED and ran' : 'not launched (declined or failed)'}`);
  }
  if (!asks.length) console.log('  (none)');

  const gaps = missingOpusReviews(launches, loadPolicy());
  console.log('\n⚠ [opus-review-follows] without a later Opus review');
  for (const g of gaps) console.log(`  ${g.agentType} [${g.category}] "${g.task}" (${g.requestedModel})`);
  if (!gaps.length) console.log('  (none)');

  console.log('\nSubagent tokens by model (input incl. cache)');
  for (const [model, m] of Object.entries(totals)) console.log(`  ${model.padEnd(20)} in ${fmt(m.input + m.cacheRead + m.cacheWrite)}  out ${fmt(m.output)}  api calls ${m.apiCalls}`);
  if (!Object.keys(totals).length) console.log('  unavailable');

  const transcripts = [...new Set(launches.map((l) => l.transcript).filter(Boolean))];
  console.log('\nMain-session (coordinator) tokens by model');
  let printed = false;
  for (const t of transcripts) {
    if (!existsSync(t)) continue;
    for (const [model, m] of Object.entries(summarizeTranscript(readFileSync(t, 'utf8').split('\n'), { sidechain: false }))) {
      console.log(`  ${model.padEnd(20)} in ${fmt(m.input + m.cacheRead + m.cacheWrite)}  out ${fmt(m.output)}  api calls ${m.apiCalls}`);
      printed = true;
    }
  }
  if (!printed) console.log('  unavailable');
  console.log('\nCost: not estimated. Subscription usage is not billed per token; use /usage (plan limits) or /cost in Claude Code.');
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'report') {
  report(args);
} else if (cmd === 'reset-writers') {
  rmSync(join(usageDir(), 'active-writers.json'), { force: true });
  console.log('Cleared active writer ownership records.');
} else {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  try {
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Agent') onPreToolUse(input);
    else if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'Agent') onPostToolUse(input);
    else if (input.hook_event_name === 'SubagentStop') onSubagentStop(input);
  } catch (err) {
    if (input.hook_event_name === 'PreToolUse') {
      // Fail closed: a broken guard must not let high-risk work through unchecked.
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `model-router guard error: ${err.message}. Fix .claude/hooks/model-routing.mjs or disable the hook in .claude/settings.json.` } }));
    } else {
      process.stderr.write(`model-routing: ${err.message}\n`);
      process.exit(1);
    }
  }
}
