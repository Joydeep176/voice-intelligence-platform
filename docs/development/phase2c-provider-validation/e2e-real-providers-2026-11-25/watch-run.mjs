// Follows an existing run to a terminal state, then records what the recording page shows. Numbers/codes only.
import { writeFileSync } from 'node:fs';
import { chromium } from '/Users/joydeepsingh/voice-intelligence-platform/apps/web/node_modules/@playwright/test/index.mjs';
const [runId, label, outDir] = process.argv.slice(2);
const WS = '00000000-0000-4000-8000-000000000001', API = `http://127.0.0.1:3000/api/v1/workspaces/${WS}`;
const t0 = Date.now(), el = () => Math.round((Date.now() - t0) / 1000), timeline = [];
let last = '', run;
for (;;) {
  try { run = await (await fetch(`${API}/runs/${runId}`)).json(); } catch { await new Promise((r) => setTimeout(r, 5000)); continue; }
  const b = JSON.stringify({ s: run.status, e: run.error, rc: run.retryCount, st: run.stages.map((s) => `${s.node}:${s.status}#${s.attempt}${s.error ? '!' + s.error.code : ''}`) });
  if (b !== last) { timeline.push({ t_s: el(), at: new Date().toISOString(), ...JSON.parse(b) }); console.log(el(), b); last = b; }
  if (['completed', 'failed', 'cancelled'].includes(run.status)) break;
  await new Promise((r) => setTimeout(r, 5000));
}
const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
await page.goto(`http://localhost:5173/recordings/${run.recordingId}`);
const sec = page.getByTestId('transcription-section');
await sec.getByLabel('Transcription run details').waitFor({ timeout: 30_000 });
const failure = await sec.getByRole('group', { name: 'Transcription failure' }).innerText().catch(() => null);
const ui = { failure: failure?.replace(/\s+/g, ' '), retryButton: await sec.getByRole('button', { name: 'Retry' }).isVisible().catch(() => false), processingCardCompleted: await page.getByTestId('processing-card').getByText('Completed', { exact: true }).isVisible().catch(() => false) };
console.log('UI', JSON.stringify(ui));
await page.screenshot({ path: `${outDir}/${label}-terminal.png`, fullPage: true });
writeFileSync(`${outDir}/${label}.json`, JSON.stringify({ runId, final: { status: run.status, error: run.error, retryCount: run.retryCount, stages: run.stages.map((s) => ({ node: s.node, status: s.status, attempt: s.attempt, error: s.error, startedAt: s.startedAt, finishedAt: s.finishedAt })) }, timeline, ui }, null, 1));
await browser.close();
