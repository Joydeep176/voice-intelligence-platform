// Phase 3A M6: A1 detection on the labelled degradation corpus (m6_corpus.py). Each clip goes
// through the REAL preprocess and `measure` tasks in a throwaway production-limit container (as in
// task-check.mjs), then the REAL A1 engine (orchestrator build, provisional rules). Reports per-flag
// detection against the known degradation, the class per condition, and false flags on clean.
// Synthetic only: never real-world accuracy. Output: numbers and labels only.
// Usage: QB_TASK_ROOT=<scratch> node m6-a1.mjs <corpus dir> <out json>
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const require = createRequire(import.meta.url);
const contracts = await import(pathToFileURL(join(REPO, 'packages/contracts/dist/index.js')).href);
const { assess } = require(join(REPO, 'apps/orchestrator/dist/agents/audio-quality/engine.js'));
const { A1_RULE_CONFIG } = require(join(REPO, 'apps/orchestrator/dist/agents/audio-quality/rule-config.js'));
const [corpusDir, outPath] = process.argv.slice(2);
const ROOT = join(process.env.QB_TASK_ROOT, 'm6-storage');
const IMAGE = 'vip-audio-service:phase3a';
const NAME = 'vip-a1-m6';
const AUDIO = 'http://127.0.0.1:8012';
const WS = '00000000-0000-4000-8000-0000000000c6';
const TOKEN = randomBytes(32).toString('hex');
const hdr = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const sh = (c, a) => spawnSync(c, a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VAD = { threshold: 0.4, minSilenceMs: 300, minSpeechMs: 250, paddingMs: 200 };

async function task(type, rec, prefix, config) {
  const res = await fetch(`${AUDIO}/v1/tasks`, {
    method: 'POST', headers: hdr,
    body: JSON.stringify({ contractVersion: contracts.AUDIO_SERVICE_CONTRACT_VERSION, type, idempotencyKey: randomUUID(), workspaceId: WS, recordingId: rec, input: { originalKey: `recordings/${WS}/${rec}/original`, outputPrefix: prefix }, config }),
  });
  const acc = await res.json();
  if (res.status !== 202) throw new Error(`${type} rejected ${res.status}`);
  for (;;) {
    const st = await (await fetch(`${AUDIO}/v1/tasks/${acc.taskId}`, { headers: hdr })).json();
    if (['succeeded', 'failed', 'cancelled'].includes(st.status)) return st;
    await sleep(300);
  }
}

const qset = (rec) => (rec ? { quantities: Object.fromEntries(Object.entries(rec.quantities).map(([k, v]) => [k, { value: v.value, kind: v.kind }])) } : null);

const manifest = JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8'));
const rows = [];
try {
  rmSync(ROOT, { recursive: true, force: true });
  const recs = {};
  for (const m of manifest) {
    recs[m.id] = randomUUID();
    const dest = join(ROOT, 'recordings', WS, recs[m.id], 'original');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(corpusDir, `${m.id}.wav`), dest);
  }
  mkdirSync(join(ROOT, 'derived'), { recursive: true });
  sh('chmod', ['-R', 'a+rwX', ROOT]);
  sh('docker', ['rm', '-f', NAME]);
  const run = sh('docker', ['run', '-d', '--name', NAME, '--init', '--cpus', '2', '--memory', '768m', '--memory-swap', '768m', '--pids-limit', '64', '--read-only', '--tmpfs', '/tmp:size=16m,noexec,nosuid,nodev', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '-e', `AUDIO_SERVICE_TOKEN=${TOKEN}`, '-e', 'AUDIO_SERVICE_STORAGE_ROOT=/storage', '-e', 'AUDIO_SERVICE_MODELS_DIR=/models', '-e', 'AUDIO_SERVICE_LANDLOCK=required', '-e', 'AUDIO_SERVICE_INFERENCE_THREADS=2', '-e', 'OMP_NUM_THREADS=2',
    '-v', `${join(ROOT, 'recordings')}:/storage/recordings:ro`, '-v', `${join(ROOT, 'derived')}:/storage/derived`, '-v', 'vip_audio-models:/models:ro', '-p', '127.0.0.1:8012:8001', IMAGE]);
  if (run.status !== 0) throw new Error(run.stderr);
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${AUDIO}/health/ready`, { headers: hdr })).status === 200) break; } catch { /* starting */ }
    await sleep(1000);
  }
  const caps = await (await fetch(`${AUDIO}/v1/capabilities`, { headers: hdr })).json();
  const pconfig = contracts.buildPreprocessConfig(contracts.toolVersionsFromCapabilities(caps));
  const hash = createHash('sha256').update(contracts.canonicalJson(pconfig)).digest('hex');
  for (const m of manifest) {
    const rec = recs[m.id];
    const prefix = `derived/${WS}/${rec}/${hash}`;
    const pre = await task('preprocess', rec, prefix, pconfig);
    if (pre.status !== 'succeeded') { rows.push({ id: m.id, error: `preprocess ${pre.error?.code}` }); continue; }
    const r = pre.result;
    const durationMs = Math.ceil(r.canonical.samples / 16);
    const meas = await task('measure', rec, prefix, { schemaVersion: 1, audioDurationMs: durationMs, vad: VAD, blockMs: 1000, windowMs: 30000, overlapMs: 1000, ltasDropDb: 50, ltasMinHz: 300, snrNearCleanDb: 45 });
    const level = JSON.parse(readFileSync(join(ROOT, r.artifacts.levelSeriesKey), 'utf8'));
    const input = {
      durationMs,
      canonical: qset(r.measurements.find((x) => x.source === 'canonical')),
      original: qset(r.measurements.find((x) => x.source === 'original_decoded')),
      levelSeries: { intervalMs: level.intervalMs, rmsDbfs: level.rmsDbfs, peakDbfs: level.peakDbfs },
      timeline: { gaps: r.timeline.gaps.map((g) => ({ startMs: g.startMs, durationMs: g.durationMs })), decodeErrors: r.timeline.decodeErrors },
      tier1: meas.status === 'succeeded'
        ? { state: 'available', quantities: qset(meas.result.record).quantities, series: { blockMs: meas.result.series.blockMs, speechMs: meas.result.series.speechMs, snrDb: meas.result.series.snrDb } }
        : { state: 'failed' },
    };
    const out = assess(input, A1_RULE_CONFIG);
    const sev = (kind) => out.flags.filter((f) => f.kind === kind).reduce((w, f) => (({ low: 1, medium: 2, high: 3 })[f.severity] > w ? ({ low: 1, medium: 2, high: 3 })[f.severity] : w), 0);
    const q = (n) => meas.result?.record?.quantities?.[n]?.value ?? null;
    rows.push({
      id: m.id, language: m.language, condition: m.condition, truth: m.truth, overall: out.overall, confidence: out.confidence,
      maxSeverity: Object.fromEntries(['clipping', 'low_level', 'narrowband', 'dropout', 'noise', 'silence', 'low_speech_presence', 'level_inconsistency', 'fragmented_speech'].map((k) => [k, sev(k)])),
      dropoutRegionsMatched: m.gapsMs.length ? m.gapsMs.filter(([a, b]) => out.flags.some((f) => f.kind === 'dropout' && f.startMs !== null && f.startMs < b + 100 && f.endMs > a - 100)).length : null,
      quantities: { clippedRatio: input.original?.quantities?.clippedRatio?.value ?? null, activeSpeechLevelDbfs: q('activeSpeechLevelDbfs'), bandwidthEdgeHz: q('bandwidthEdgeHz'), snrDb: q('snrDb'), speechRatio: q('speechRatio') },
    });
    console.log(m.id, out.overall, JSON.stringify(rows.at(-1).maxSeverity));
  }
} finally {
  sh('docker', ['rm', '-f', NAME]);
  rmSync(ROOT, { recursive: true, force: true });
  // Detection summary: a clip "detects" its degradation when a flag of the true kind reaches the
  // severity; false flags = the same kind on clean clips.
  const kinds = ['clipping', 'low_level', 'narrowband', 'dropout'];
  const summary = {};
  for (const k of kinds) {
    for (const min of [1, 2]) {
      const pos = rows.filter((r) => r.truth === k);
      const neg = rows.filter((r) => r.truth !== k && !r.error);
      const tp = pos.filter((r) => r.maxSeverity?.[k] >= min).length;
      const fp = neg.filter((r) => r.maxSeverity?.[k] >= min).length;
      summary[`${k}@${min === 1 ? 'any' : 'medium+'}`] = { positives: pos.length, tp, recall: pos.length ? +(tp / pos.length).toFixed(3) : null, fp, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null };
    }
  }
  const byCondition = {};
  for (const r of rows) {
    if (r.error) continue;
    const g = (byCondition[r.condition] ??= {});
    g[r.overall] = (g[r.overall] ?? 0) + 1;
  }
  writeFileSync(outPath, JSON.stringify({ ruleVersion: A1_RULE_CONFIG.ruleVersion, note: 'Real preprocess + measure tasks (production image, 2 CPUs / 768 MB) and the real A1 engine; synthetic corpus only.', summary, byCondition, rows }, null, 1) + '\n');
}
