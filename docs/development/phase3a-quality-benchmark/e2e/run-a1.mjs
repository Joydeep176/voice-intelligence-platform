// Phase 3A M7: browser E2E of A1 Audio Quality on the running dev stack (web :5173 -> API :3000 ->
// orchestrator -> audio service with the `measure` task). Synthetic clips only (ADR-0004).
// Part A: per category clip, upload + preprocessing through the UI, then the A1 assessment in the UI
// and the API. Part B (AC-3): a new transcription run on the stored Phase 2C reference recording
// while A1 is active; its transcript must equal the 2C reference transcript (compared by hashes).
// Output: numbers, statuses and codes only (no transcript text).
// Usage: node run-a1.mjs <clips dir> <screenshot dir> <out json>
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '/Users/joydeepsingh/voice-intelligence-platform/apps/web/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '/Users/joydeepsingh/voice-intelligence-platform/apps/web/node_modules/@axe-core/playwright/dist/index.mjs';

const [clipsDir, shotDir, outPath] = process.argv.slice(2);
// Optional: ONLY=a,b (clip labels) re-runs just those clips and merges into an existing result file;
// SKIP_AC3=1 skips Part B; REUSE_RUN=<runId> checks an already started reference re-run instead of
// starting one (with ONLY=none: Part B alone).
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const WEB = 'http://localhost:5173';
const API = 'http://127.0.0.1:3000';
const REF = { recordingId: '7126ea13-a9ec-425a-a46b-b6d49d91b5ef', runId: 'f8d08080-3d77-4e66-ad56-9d89f3bc8375' };
const SHOTS = new Set(['clean-en', 'noisy-0db-hi', 'silence-30s']);
const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const out = ONLY && existsSync(outPath)
  ? { ...JSON.parse(readFileSync(outPath, 'utf8')), consoleErrors: [] }
  : { startedAt: new Date().toISOString(), clips: {}, consoleErrors: [] };

const browser = await chromium.launch();
// A context-owned page: @axe-core/playwright requires one.
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
let ws = null;
page.on('console', (m) => { if (m.type() === 'error') out.consoleErrors.push(m.text().slice(0, 200)); });
page.on('request', (r) => { const m = r.url().match(/\/api\/v1\/workspaces\/([0-9a-f-]{36})\//); if (m) ws = m[1]; });
const api = async (path, method = 'GET') => {
  const r = await (method === 'GET' ? page.request.get(`${API}/api/v1/workspaces/${ws}${path}`) : page.request.post(`${API}/api/v1/workspaces/${ws}${path}`));
  return { status: r.status(), body: r.ok() ? await r.json() : null };
};

async function clip(file) {
  const label = file.replace(/\.wav$/, '');
  const res = { label };
  await page.goto(WEB + '/');
  await page.getByRole('link', { name: /upload recording/i }).first().click();
  const name = `a1-${label}-${Date.now()}.wav`;
  await page.getByLabel('Audio file').setInputFiles({ name, mimeType: 'audio/wav', buffer: readFileSync(join(clipsDir, file)) });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('heading', { name: /upload complete/i }).waitFor({ timeout: 60_000 });
  await page.getByRole('link', { name: 'View recording' }).click();
  await page.getByRole('heading', { name }).waitFor();
  const recId = page.url().split('/').pop();
  const card = page.getByTestId('processing-card');
  await card.getByRole('button', { name: 'Start processing' }).click();
  await card.getByText('Completed', { exact: true }).waitFor({ timeout: 10 * 60_000 });
  const tProcessed = Date.now();
  const rec = await api(`/recordings/${recId}`);
  const runId = rec.body?.latestRun?.id;
  res.runStatusBefore = rec.body?.latestRun?.status ?? null;
  let snap = null;
  for (let i = 0; i < 120; i++) {
    snap = (await api(`/runs/${runId}/audio-diagnostics`)).body;
    if (snap && ['completed', 'failed', 'cancelled'].includes(snap.state)) break;
    await page.waitForTimeout(2000);
  }
  res.secondsFromProcessedToAssessment = Math.round((Date.now() - tProcessed) / 1000);
  res.state = snap?.state ?? 'TIMEOUT';
  const d = snap?.diagnostics;
  if (d) {
    const s = d.summary;
    const ranged = d.flags.filter((f) => f.startMs !== null);
    Object.assign(res, {
      overall: s.overall, confidence: s.confidence, tier1: s.tier1, provisional: s.provisional,
      transcription: s.suitability.transcription.value, transcriptionReasons: s.suitability.transcription.reasons,
      diarization: s.suitability.diarization.value, flagCounts: s.flagCounts, rangedFlags: ranged.length,
      notAssessed: s.notAssessed.map((n) => n.dimension), recommendations: d.recommendations.map((r) => r.code),
      measurementSet: snap.measurementSet,
    });
    // what the UI shows, without a reload
    const aq = page.locator('[aria-labelledby="audio-quality-title"]');
    const label = { good: 'Good', acceptable_with_warnings: 'Acceptable, with warnings', poor: 'Poor', insufficient: 'Insufficient' }[s.overall];
    res.ui = {
      classShown: await aq.getByText(label, { exact: true }).waitFor({ timeout: 30_000 }).then(() => true, () => false),
      provisionalShown: await aq.getByText(/provisional thresholds/i).isVisible().catch(() => false),
      stepComplete: await page.getByRole('list', { name: 'Workflow steps' }).getByText('Audio quality analysis').locator('xpath=..').getByText('Complete').isVisible().catch(() => false),
      timelineBars: await page.getByTestId('diagnostic-bar').count(),
      createdRunWording: await page.getByText(/audio assessed; transcription has not been started/i).isVisible().catch(() => false),
    };
    res.ui.timelineMatchesApi = res.ui.timelineBars === ranged.length;
  }
  res.runStatusAfter = (await api(`/recordings/${recId}`)).body?.latestRun?.status ?? null; // never submitted by A1
  if (SHOTS.has(label)) {
    await page.screenshot({ path: join(shotDir, `a1-${label}.png`), fullPage: true });
    const axe = await new AxeBuilder({ page }).analyze();
    res.axe = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id);
  }
  const other = await page.request.get(`${API}/api/v1/workspaces/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10/runs/${runId}/audio-diagnostics`);
  res.otherWorkspaceStatus = other.status();
  log(label, JSON.stringify(res));
  return res;
}

async function allSegments(runId) {
  const items = [];
  let cursor = null;
  do {
    const r = await api(`/runs/${runId}/transcript?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    items.push(...(r.body?.items ?? []));
    cursor = r.body?.nextCursor ?? null;
  } while (cursor);
  return items;
}

async function transcriptUnchanged() {
  if (!ws) {
    // Part B alone (ONLY=none): open the app once so the workspace ID and session are known.
    await page.goto(`${WEB}/`);
    for (let i = 0; i < 40 && !ws; i++) await page.waitForTimeout(250);
  }
  const before = await allSegments(REF.runId);
  const started = process.env.REUSE_RUN ? null : await api(`/recordings/${REF.recordingId}/runs`, 'POST');
  const runId = process.env.REUSE_RUN ?? started.body?.id;
  log('reference re-run', runId, started?.status ?? 'reused');
  let run = null;
  for (let i = 0; i < 360; i++) {
    // Tolerate a dev API restart (watch mode) while polling.
    run = await api(`/runs/${runId}`).then((r) => r.body, () => null);
    if (['completed', 'failed', 'cancelled'].includes(run?.status)) break;
    await page.waitForTimeout(5000);
  }
  const after = run?.status === 'completed' ? await allSegments(runId) : [];
  const key = (s) => [s.startMs, s.endMs, s.language, createHash('sha256').update(s.text).digest('hex')].join('|');
  // speaker IDs differ per run; compare the partition of segments into speakers instead
  const partition = (segs) => {
    const map = new Map();
    return segs.map((s) => { if (!map.has(s.speakerId)) map.set(s.speakerId, map.size); return map.get(s.speakerId); }).join(',');
  };
  const aq = (await api(`/runs/${runId}/audio-diagnostics`)).body;
  return {
    referenceRunId: REF.runId, newRunId: runId, newRunStatus: run?.status ?? 'TIMEOUT',
    segmentsBefore: before.length, segmentsAfter: after.length,
    identicalSegments: before.length === after.length && before.every((s, i) => key(s) === key(after[i])),
    identicalSpeakerPartition: partition(before) === partition(after),
    transcriptionStage: run?.stages?.map((s) => ({ node: s.node, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt })),
    a1State: aq?.state ?? null, a1Overall: aq?.diagnostics?.summary.overall ?? null, a1Tier1: aq?.diagnostics?.summary.tier1 ?? null,
  };
}

try {
  for (const file of readdirSync(clipsDir).filter((f) => f.endsWith('.wav') && (!ONLY || ONLY.has(f.replace(/\.wav$/, '')))).sort()) {
    try { out.clips[file] = await clip(file); }
    catch (e) { out.clips[file] = { error: String(e).slice(0, 300) }; log(file, 'ERROR', String(e).slice(0, 200)); }
  }
  if (!process.env.SKIP_AC3) {
    out.transcriptUnchanged = await transcriptUnchanged();
    log('AC-3', JSON.stringify(out.transcriptUnchanged));
  }
} finally {
  out.finishedAt = new Date().toISOString();
  writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n');
  await browser.close();
}
