// Failure-path browser E2E against the real stack (Phase 2B/2C closure). Synthetic inputs only (ADR-0004).
// Output: statuses, codes, counts and timings only. Usage: node run-failures.mjs <scenario> <outdir>
// Scenarios: invalid | unsupported | duplicate | cancel-retry | outage | dense
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '/Users/joydeepsingh/voice-intelligence-platform/apps/web/node_modules/@playwright/test/index.mjs';

const [scenario, outDir] = process.argv.slice(2);
const IN = new URL('./in/', import.meta.url).pathname;
const WEB = 'http://localhost:5173';
const API = 'http://127.0.0.1:3000';
const t0 = Date.now();
const el = () => Math.round((Date.now() - t0) / 100) / 10;
const out = { scenario, startedAt: new Date().toISOString(), steps: [], timeline: [] };
const step = (name, data = {}) => { out.steps.push({ name, t_s: el(), ...data }); console.log(`[${scenario} ${el()}s]`, name, JSON.stringify(data)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
let ws = null;
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('request', (r) => { const m = r.url().match(/\/api\/v1\/workspaces\/([0-9a-f-]{36})\//); if (m) ws = m[1]; });
const api = async (path, method = 'GET', data) => {
  const r = await page.request.fetch(`${API}/api/v1/workspaces/${ws}${path}`, { method, data, headers: data ? { 'content-type': 'application/json' } : {} });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status(), body };
};
const section = () => page.getByTestId('transcription-section');
const card = () => page.getByTestId('processing-card');
const shot = (n) => page.screenshot({ path: `${outDir}/fail-${scenario}-${n}.png`, fullPage: true });

async function upload(buffer, name) {
  await page.goto(WEB + '/');
  await page.getByRole('link', { name: /upload recording/i }).first().click();
  await page.getByLabel('Audio file').setInputFiles({ name, mimeType: 'audio/wav', buffer });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('heading', { name: /upload complete/i }).waitFor({ timeout: 60_000 });
  await page.getByRole('link', { name: 'View recording' }).click();
  await page.getByRole('heading', { name }).waitFor();
  return page.url().split('/').pop();
}
async function processed(file) {
  const name = `fail-${scenario}-${Date.now()}.wav`;
  const recId = await upload(readFileSync(IN + file), name);
  await card().getByRole('button', { name: 'Start processing' }).click();
  await card().getByText('Completed', { exact: true }).waitFor({ timeout: 10 * 60_000 });
  return recId;
}
const runOf = async (recId) => (await api(`/recordings/${recId}`)).body?.latestRun?.id;
const snap = async (runId) => (await api(`/runs/${runId}`)).body;
const brief = (r) => r && { status: r.status, error: r.error ?? null, retryCount: r.retryCount, cancelRequested: r.cancelRequested, transcriptAvailable: r.transcriptAvailable,
  stages: r.stages.map((s) => `${s.node}:${s.status}#${s.attempt}${s.progress ? '@' + Math.round(s.progress.fraction * 100) : ''}${s.error ? '!' + s.error.code : ''}`).join(',') };
async function waitRun(runId, pred, minutes) {
  const end = Date.now() + minutes * 60_000;
  let last = '';
  while (Date.now() < end) {
    const r = await snap(runId);
    const b = JSON.stringify(brief(r));
    if (b !== last) { out.timeline.push({ t_s: el(), ...brief(r) }); console.log(`[${scenario} ${el()}s] run`, b); last = b; }
    if (pred(r)) return r;
    await page.waitForTimeout(3000);
  }
  return null;
}
const uiText = async (loc) => (await loc.isVisible().catch(() => false)) ? (await loc.innerText()).replace(/\s+/g, ' ').slice(0, 300) : null;

function wav(channels, seconds, rate = 16000) {
  const n = Math.round(seconds * rate), bytes = n * channels * 2, b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8, 'latin1'); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < n * channels; i++) b.writeInt16LE(Math.round(Math.sin(i / 7) * 8000), 44 + i * 2);
  return b;
}

try {
  if (scenario === 'invalid' || scenario === 'unsupported') {
    const buf = scenario === 'invalid' ? Buffer.from('RIFF\0\0\0\0WAVEnot really audio, synthetic garbage '.repeat(200)) : wav(9, 2);
    const recId = await upload(buf, `fail-${scenario}-${Date.now()}.wav`);
    step('uploaded', { recId: Boolean(recId) });
    // Validation (probe) runs automatically when the upload completes; no Start button is offered.
    const failed = await card().getByText(/rejected|failed/i).first().waitFor({ timeout: 5 * 60_000 }).then(() => true, () => false);
    const proc = await api(`/recordings/${recId}/processing`);
    const rec = await api(`/recordings/${recId}`);
    step('processing-outcome', { uiShowsFailure: failed, uiCard: await uiText(card()), apiProcessing: proc.status, processing: JSON.stringify(proc.body).slice(0, 400), recordingStatus: rec.body?.status,
      transcribeButton: await section().getByRole('button', { name: 'Start transcription' }).isVisible().catch(() => false) });
    const start = await api(`/recordings/${recId}/runs`, 'POST', {});
    step('start-run-on-invalid', { status: start.status, code: start.body?.code ?? start.body?.type ?? null });
    await shot('01');
  }

  if (scenario === 'duplicate') {
    const recId = await processed('e2e-hinglish-6clips.wav');
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => api(`/recordings/${recId}/runs`, 'POST', {})));
    step('three-concurrent-posts', { statuses: [a.status, b.status, c.status], runIds: new Set([a.body?.id, b.body?.id, c.body?.id]).size });
    const d = await api(`/recordings/${recId}/runs`, 'POST', {});
    step('post-while-active', { status: d.status, sameRun: d.body?.id === a.body?.id });
    const bad = await api(`/recordings/${recId}/runs`, 'POST', { reportLanguage: 'hi' });
    step('unknown-field-rejected', { status: bad.status });
    const r = await waitRun(a.body.id, (x) => ['completed', 'failed', 'cancelled'].includes(x?.status), 20);
    step('final', brief(r));
    const runs = await page.request.get(`${API}/api/v1/workspaces/${ws}/recordings/${recId}`);
    step('recording-latestRun', { same: (await runs.json()).latestRun?.id === a.body.id });
  }

  if (scenario === 'cancel-retry') {
    const recId = await processed('e2e-mixed-en-hi-90s.wav');
    await section().getByRole('button', { name: 'Start transcription' }).click();
    const runId = await (async () => { for (let i = 0; i < 20; i++) { const id = await runOf(recId); if (id) return id; await page.waitForTimeout(500); } })();
    await waitRun(runId, (x) => x?.stages?.[0]?.progress?.fraction >= 0.25, 10);
    await section().getByRole('button', { name: 'Cancel' }).click();
    step('cancel-clicked', { uiNote: await uiText(section().getByText('Cancellation requested. Waiting for the run to stop.')) });
    const c = await waitRun(runId, (x) => ['cancelled', 'failed', 'completed'].includes(x?.status), 10);
    const uiCancelled = await section().getByText('The run was cancelled. No transcript was stored.').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const raw = await api(`/runs/${runId}/transcript/raw`);
    const tr = await api(`/runs/${runId}/transcript`);
    step('after-cancel', { ...brief(c), uiCancelled, retryButton: await section().getByRole('button', { name: 'Retry' }).isVisible(), rawStatus: raw.status, rawWindowsStored: (raw.body?.stt ?? raw.body?.items ?? []).length ?? null, rawKeys: raw.body ? Object.keys(raw.body) : null, transcriptStatus: tr.status });
    await shot('01-cancelled');
    const tRetry = el();
    await section().getByRole('button', { name: 'Retry' }).click();
    const r = await waitRun(runId, (x) => ['completed', 'failed', 'cancelled'].includes(x?.status) && x.retryCount >= 1, 20);
    const uiDone = await section().getByText('Completed', { exact: true }).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const tr2 = await api(`/runs/${runId}/transcript`);
    const raw2 = await api(`/runs/${runId}/transcript/raw`);
    step('after-retry', { ...brief(r), retry_wall_s: Math.round(el() - tRetry), uiCompleted: uiDone, segments: tr2.body?.items?.length, rawKeys: raw2.body ? Object.keys(raw2.body) : null, raw: JSON.stringify(raw2.body).replace(/"sha256":"[0-9a-f]+"/g, '"sha256":"…"').slice(0, 900) });
    await shot('02-retried');
  }

  if (scenario === 'outage') {
    const recId = await processed('e2e-hinglish-6clips.wav');
    await section().getByRole('button', { name: 'Start transcription' }).click();
    const runId = await (async () => { for (let i = 0; i < 20; i++) { const id = await runOf(recId); if (id) return id; await page.waitForTimeout(500); } })();
    await waitRun(runId, (x) => x?.status === 'running', 5);
    await page.waitForTimeout(20_000);
    execFileSync('docker', ['pause', 'vip-audio-service-1']);
    step('audio-service-paused');
    await page.waitForTimeout(60_000);
    const during = await snap(runId);
    step('during-outage', { ...brief(during), uiRefreshNote: await uiText(section().getByText('Could not refresh the status. Showing the last known state.')) });
    execFileSync('docker', ['unpause', 'vip-audio-service-1']);
    step('audio-service-unpaused');
    const r = await waitRun(runId, (x) => ['completed', 'failed', 'cancelled'].includes(x?.status), 25);
    const ui = await uiText(section().getByLabel('Transcription run details'));
    step('after-outage', { ...brief(r), uiDetails: ui });
    await shot('01');
    if (r?.status === 'failed') {
      // Recovery: the user retries once the service is back (stored windows are reused).
      await page.waitForTimeout(5000);
      await section().getByRole('button', { name: 'Retry' }).click();
      const r2 = await waitRun(runId, (x) => ['completed', 'failed', 'cancelled'].includes(x?.status) && x.retryCount >= 1, 25);
      step('after-retry', { ...brief(r2), uiCompleted: await section().getByText('Completed', { exact: true }).first().isVisible().catch(() => false) });
      await shot('02-retried');
    }
    // Inference tasks the service queued for this scenario (duplicates show up as extra transcribe tasks).
    const logs = execFileSync('sh', ['-c', `docker logs --since ${out.startedAt} vip-audio-service-1 2>&1`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const queued = logs.split('\n').filter((l) => l.includes('task_queued')).map((l) => (l.match(/"taskType": "([a-z]+)"/) ?? [])[1]);
    step('service-tasks-queued', queued.reduce((a, t) => ((a[t] = (a[t] ?? 0) + 1), a), {}));
  }

  if (scenario === 'dense') {
    const recId = await processed('e2e-dense-13utt.wav');
    await section().getByRole('button', { name: 'Start transcription' }).click();
    const runId = await (async () => { for (let i = 0; i < 20; i++) { const id = await runOf(recId); if (id) return id; await page.waitForTimeout(500); } })();
    const r = await waitRun(runId, (x) => ['completed', 'failed', 'cancelled'].includes(x?.status), 30);
    const failure = await uiText(section().getByRole('group', { name: 'Transcription failure' }));
    const tr = r?.status === 'completed' ? await api(`/runs/${runId}/transcript`) : null;
    step('final', { ...brief(r), uiFailure: failure, retryButton: await section().getByRole('button', { name: 'Retry' }).isVisible().catch(() => false),
      retriesNote: await uiText(section().getByText(/retr(y|ies) remaining/)), segments: tr?.body?.items?.length ?? null });
    await shot('01');
  }
} catch (e) {
  step('ERROR', { message: String(e).slice(0, 300) });
  await shot('99-error').catch(() => {});
  process.exitCode = 1;
} finally {
  if (scenario === 'outage') { try { execFileSync('docker', ['unpause', 'vip-audio-service-1'], { stdio: 'ignore' }); } catch {} }
  out.consoleErrors = consoleErrors.slice(0, 20);
  out.total_s = el();
  writeFileSync(`${outDir}/fail-${scenario}.json`, JSON.stringify(out, null, 1));
  await browser.close();
}
