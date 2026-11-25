// Real-provider browser E2E (Phase 2B/2C closure). Drives the running web (Vite :5173) -> API (:3000)
// -> orchestrator (user's, STT_PROVIDER=whisper-cpp, DIARIZATION_PROVIDER=sherpa-onnx) -> audio service.
// Inputs are synthetic TTS (ADR-0004). Output: numbers, statuses and codes only (no transcript text).
// Usage: node run-real.mjs <wav> <label> <outdir>
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium } from '/Users/joydeepsingh/voice-intelligence-platform/apps/web/node_modules/@playwright/test/index.mjs';

const [wavPath, label, outDir] = process.argv.slice(2);
const WEB = 'http://localhost:5173';
const API = 'http://127.0.0.1:3000';
const t0 = Date.now();
const el = () => Math.round((Date.now() - t0) / 100) / 10;
const log = (...a) => console.log(`[${label} ${el()}s]`, ...a);
const out = { label, file: basename(wavPath), startedAt: new Date().toISOString(), steps: [], uiTimeline: [], apiTimeline: [] };
const step = (name, data = {}) => { out.steps.push({ name, t_s: el(), ...data }); log(name, JSON.stringify(data)); };
const shot = (page, n) => page.screenshot({ path: `${outDir}/${label}-${n}.png`, fullPage: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
let ws = null;
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('request', (r) => { const m = r.url().match(/\/api\/v1\/workspaces\/([0-9a-f-]{36})\//); if (m) ws = m[1]; });
const api = async (path) => { const r = await page.request.get(`${API}/api/v1/workspaces/${ws}${path}`); return { status: r.status(), body: r.ok() ? await r.json() : null }; };

try {
  // 1. Upload through the UI
  await page.goto(WEB + '/');
  await page.getByRole('link', { name: /upload recording/i }).first().click();
  const name = `${label}-${Date.now()}.wav`;
  await page.getByLabel('Audio file').setInputFiles({ name, mimeType: 'audio/wav', buffer: readFileSync(wavPath) });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('heading', { name: /upload complete/i }).waitFor({ timeout: 60_000 });
  step('upload-complete');
  await page.getByRole('link', { name: 'View recording' }).click();
  await page.getByRole('heading', { name }).waitFor();
  const recId = page.url().split('/').pop();
  out.recordingId = recId;
  step('recording-page', { workspaceFromRequests: Boolean(ws) });

  // 2. Preprocessing through the UI
  const card = page.getByTestId('processing-card');
  await card.getByRole('button', { name: 'Start processing' }).click();
  await card.getByText('Completed', { exact: true }).waitFor({ timeout: 10 * 60_000 });
  const proc = await api(`/recordings/${recId}/processing`);
  step('preprocessing-completed', { apiStatus: proc.status, processingStatus: proc.body?.status ?? proc.body?.latest?.status ?? null });
  const rec = await api(`/recordings/${recId}`);
  step('recording-after-processing', { status: rec.body?.status, durationMs: rec.body?.durationMs });
  await shot(page, '01-processed');

  // 3. Transcription through the UI, with UI vs API status sampled together
  const section = page.getByTestId('transcription-section');
  await section.getByRole('button', { name: 'Start transcription' }).click();
  step('transcription-started');
  const badge = async () => {
    for (const s of ['Queued', 'Running', 'Completed', 'Failed', 'Cancelled']) {
      if (await section.getByText(s, { exact: true }).first().isVisible().catch(() => false)) return s;
    }
    return null;
  };
  let runId = null;
  let final = null;
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    const r = await api(`/recordings/${recId}`);
    runId = r.body?.latestRun?.id ?? runId;
    const run = runId ? (await api(`/runs/${runId}`)).body : null;
    const ui = await badge();
    const pb = await section.getByRole('progressbar').first().getAttribute('aria-valuenow').catch(() => null);
    const apiStatus = run?.status ?? null;
    const stages = (run?.stages ?? []).map((s) => `${s.node}:${s.status}${s.progress ? '@' + Math.round(s.progress.fraction * 100) : ''}${s.error ? '!' + s.error.code : ''}`).join(',');
    const last = out.apiTimeline.at(-1);
    if (!last || last.api !== apiStatus || last.stages !== stages || last.ui !== ui) {
      out.apiTimeline.push({ t_s: el(), api: apiStatus, stages, ui, progressbar: pb });
      log('status', apiStatus, '| ui', ui, '|', stages, '| bar', pb);
    }
    if (['completed', 'failed', 'cancelled'].includes(apiStatus)) { final = run; break; }
    await page.waitForTimeout(5000);
  }
  // UI must reach the same terminal state without a reload
  const terminalUi = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' }[final?.status];
  let uiMatched = false;
  if (terminalUi) uiMatched = await section.getByText(terminalUi, { exact: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  out.run = final && {
    id: final.id, status: final.status, retryCount: final.retryCount, providers: final.providers, window: final.window,
    error: final.error ?? null, stages: final.stages.map((s) => ({ node: s.node, status: s.status, attempt: s.attempt, error: s.error, startedAt: s.startedAt, finishedAt: s.finishedAt })),
  };
  step('run-terminal', { status: final?.status ?? 'TIMEOUT(45min)', uiMatchedWithoutReload: uiMatched });
  await shot(page, '02-terminal');

  if (final?.status === 'completed') {
    // 4. What the UI shows
    const segs = section.getByTestId('segment');
    await segs.first().waitFor({ timeout: 30_000 });
    const n = await segs.count();
    const texts = await segs.locator('p').allInnerTexts();
    const langBadges = await segs.locator('[data-slot="badge"]').allInnerTexts();
    const ui = {
      segments: n,
      fakeBanner: await section.getByTestId('fake-provider-banner').isVisible().catch(() => false),
      languageBadges: langBadges.map((s) => s.replace('Language: ', '').trim()).reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}),
      devanagariSegments: texts.filter((t) => /[ऀ-ॿ]/.test(t)).length,
      latinSegments: texts.filter((t) => /[A-Za-z]/.test(t)).length,
      emptySegments: texts.filter((t) => !t.trim()).length,
      speakerRows: await section.getByTestId('speaker-row').count(),
    };
    step('ui-transcript', ui);
    // 5. What the API holds (persisted)
    const tr = await api(`/runs/${runId}/transcript`);
    const sp = await api(`/runs/${runId}/speakers`);
    const un = await api(`/runs/${runId}/transcript/uncertainties`);
    const items = tr.body?.items ?? tr.body?.segments ?? [];
    const apiSeg = {
      transcriptStatus: tr.status, version: tr.body?.version ?? null, segments: items.length,
      languages: items.reduce((a, s) => ((a[s.language] = (a[s.language] ?? 0) + 1), a), {}),
      devanagariSegments: items.filter((s) => /[ऀ-ॿ]/.test(s.text)).length,
      withSpeaker: items.filter((s) => s.speakerId).length, monotonic: items.every((s, i) => s.startMs <= s.endMs && (i === 0 || items[i - 1].startMs <= s.startMs)),
      maxEndMs: Math.max(...items.map((s) => s.endMs)), speakers: (sp.body?.items ?? []).length, uncertainties: (un.body?.items ?? []).length,
      uncertaintyKinds: (un.body?.items ?? []).reduce((a, u) => ((a[u.kind] = (a[u.kind] ?? 0) + 1), a), {}), nextCursor: tr.body?.nextCursor ?? null,
    };
    step('api-transcript', apiSeg);
    out.uiMatchesApi = { segments: ui.segments === apiSeg.segments, devanagari: ui.devanagariSegments === apiSeg.devanagariSegments, speakers: ui.speakerRows === apiSeg.speakers };
    // 6. Persistence across a full reload
    await page.reload();
    await section.getByTestId('segment').first().waitFor({ timeout: 30_000 });
    step('after-reload', { segments: await section.getByTestId('segment').count(), completedBadge: await section.getByText('Completed', { exact: true }).first().isVisible() });
    await shot(page, '03-reloaded');
    // 7. Workspace isolation: same recording under another workspace id is 404
    const other = await page.request.get(`${API}/api/v1/workspaces/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10/runs/${runId}`);
    const otherRec = await page.request.get(`${API}/api/v1/workspaces/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10/recordings/${recId}`);
    step('workspace-isolation', { otherWorkspaceRun: other.status(), otherWorkspaceRecording: otherRec.status() });
  }
} catch (e) {
  step('ERROR', { message: String(e).slice(0, 300) });
  await shot(page, '99-error').catch(() => {});
  process.exitCode = 1;
} finally {
  out.consoleErrors = consoleErrors.slice(0, 20);
  out.finishedAt = new Date().toISOString();
  out.total_s = el();
  writeFileSync(`${outDir}/${label}.json`, JSON.stringify(out, null, 1));
  await browser.close();
}
