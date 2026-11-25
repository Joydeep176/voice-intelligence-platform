import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route, test } from '@playwright/test';
import { completed as processingCompleted } from './processing-fixtures';
import {
  cancelled,
  completed,
  failed,
  page as transcriptPage,
  queued,
  REC_ID,
  run,
  RUN_ID,
  running,
  speakers,
  uncertainties,
} from './transcription-fixtures';

/**
 * Transcript section (Phase 2C C2) against a fully mocked network: no API, database or audio
 * service is needed, and nothing is created in the development database.
 */
const WS = '00000000-0000-4000-8000-000000000001';
const base = `/api/v1/workspaces/${WS}`;
const fresh = () => new Date().toISOString();

const recording = {
  id: REC_ID,
  workspaceId: WS,
  originalFilename: 'synthetic-tone.wav',
  mimeType: 'audio/wav',
  sizeBytes: 12_844,
  durationMs: 60_000,
  sha256: 'a'.repeat(64),
  status: 'valid',
  createdAt: fresh(),
  updatedAt: fresh(),
  latestRun: run(),
};

const reply = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** GET run returns `before` until the start POST, then `after` in turn (the last one repeats). */
async function mockApi(
  page: Page,
  before: unknown,
  after: unknown[] = [],
  startBody: unknown = queued(),
) {
  let started = false;
  let i = 0;
  const names = new Map<string, string>();
  await page.route('**/api/v1/**', (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === `${base}/recordings/${REC_ID}`) return reply(route, 200, recording);
    if (pathname.startsWith(`${base}/recordings/${REC_ID}/processing`)) {
      return reply(route, 200, processingCompleted());
    }
    if (pathname === `${base}/recordings/${REC_ID}/runs` && method === 'POST') {
      started = true;
      return reply(route, 202, startBody);
    }
    if (pathname === `${base}/runs/${RUN_ID}`) {
      return reply(route, 200, started ? after[Math.min(i++, after.length - 1)] : before);
    }
    if (pathname === `${base}/runs/${RUN_ID}/transcript`)
      return reply(route, 200, transcriptPage());
    if (pathname === `${base}/runs/${RUN_ID}/transcript/versions`) {
      return reply(route, 200, { items: [] });
    }
    if (pathname === `${base}/runs/${RUN_ID}/transcript/uncertainties`) {
      return reply(route, 200, { version: 1, items: uncertainties, nextCursor: null });
    }
    if (pathname === `${base}/runs/${RUN_ID}/speakers`) {
      return reply(route, 200, {
        items: speakers.map((s) => ({ ...s, displayName: names.get(s.id) ?? s.displayName })),
      });
    }
    if (pathname.startsWith(`${base}/runs/${RUN_ID}/speakers/`) && method === 'PATCH') {
      const id = pathname.split('/').pop()!;
      const { displayName } = route.request().postDataJSON() as { displayName: string };
      names.set(id, displayName);
      return reply(route, 200, { ...speakers.find((s) => s.id === id), displayName });
    }
    if (pathname === '/api/v1/health') {
      return reply(route, 200, {
        status: 'ok',
        service: 'api',
        version: '0.1.0',
        environment: 'test',
        time: fresh(),
        dependencies: [],
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
  });
}

const section = (page: Page) => page.getByTestId('transcription-section');

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="transcription-section"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test('start, running, then completed with transcript and rename', async ({ page }) => {
  await mockApi(page, run(), [queued(), running(0.3), running(null, 0.5), completed()]);
  await page.goto(`/recordings/${REC_ID}`);
  await expect(section(page).getByText('Not started', { exact: true })).toBeVisible();
  await section(page).getByRole('button', { name: 'Start transcription' }).click();
  await expect(section(page).getByText('Queued', { exact: true })).toBeVisible();
  await expect(section(page).getByText('Running', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    section(page).getByRole('progressbar', { name: 'Transcription progress' }),
  ).toHaveAttribute('aria-valuenow', '30');
  await expect(section(page).getByText('Completed', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(section(page).getByTestId('fake-provider-banner')).toBeVisible();
  await expect(section(page).getByTestId('segment')).toHaveCount(4);
  await expect(section(page).getByText('यह एक परीक्षण पंक्ति है')).toBeVisible();
  await expect(section(page).getByText('Overlapping speech')).toBeVisible();

  const row = section(page).getByTestId('speaker-row').filter({ hasText: 'SPEAKER_00' });
  await row.getByRole('button', { name: 'Rename SPEAKER_00' }).click();
  await row.getByLabel('Display name for SPEAKER_00').fill('Asha');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByRole('button', { name: 'Rename Asha' })).toBeFocused();
  await expect(row).toContainText('SPEAKER_00');
  await expect(section(page).getByTestId('segment').first()).toContainText('Asha');
  await expectNoBlockingViolations(page);
});

const STATES: [string, unknown][] = [
  ['not started', run()],
  ['queued', queued()],
  ['running', running(0.5, 0.2)],
  ['running, unknown fraction', running(null)],
  ['completed with transcript', completed()],
  ['failed', failed()],
  ['cancelled', cancelled()],
];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
    });
    for (const [name, state] of STATES) {
      test(`${name}: no serious or critical violations`, async ({ page }) => {
        await mockApi(page, state);
        await page.goto(`/recordings/${REC_ID}`);
        await expect(section(page).getByLabel('Transcription run details')).toBeVisible();
        if (name === 'completed with transcript') {
          await expect(section(page).getByTestId('segment')).toHaveCount(4);
        }
        await expectNoBlockingViolations(page);
      });
    }
  });
}

test('no horizontal overflow at phone width with a transcript', async ({ page }) => {
  await mockApi(page, completed());
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(`/recordings/${REC_ID}`);
  await expect(section(page).getByTestId('segment')).toHaveCount(4);
  const overflow = await page.locator('html').evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflow).toBe(false);
});
