import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Route, test } from '@playwright/test';
import { cancelled, completed, failed, pre, processing, REC_ID, snap } from './processing-fixtures';

/**
 * Audio processing card (Phase 2B WS8) against a fully mocked network: no API, database or audio
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
  durationMs: 10_000,
  sha256: 'a'.repeat(64),
  status: 'valid',
  createdAt: fresh(),
  updatedAt: fresh(),
  latestRun: null,
};

const reply = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * GET returns `before` until a POST happens, then `after` in turn (the last one repeats). Keyed on the
 * POST, not on call counts, because React StrictMode double-fetches on mount in dev.
 */
async function mockApi(
  page: Page,
  before: unknown,
  post: (path: string) => { status: number; body: unknown } = () => ({ status: 500, body: {} }),
  after: unknown[] = [],
) {
  let posted = false;
  let i = 0;
  await page.route('**/api/v1/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === `${base}/recordings/${REC_ID}`) return reply(route, 200, recording);
    if (pathname.startsWith(`${base}/recordings/${REC_ID}/processing`)) {
      if (route.request().method() === 'POST') {
        posted = true;
        const r = post(pathname);
        return reply(route, r.status, r.body);
      }
      return reply(route, 200, posted ? after[Math.min(i++, after.length - 1)] : before);
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

const card = (page: Page) => page.getByTestId('processing-card');

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="processing-card"]')
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

test('start, processing, then completed', async ({ page }) => {
  await mockApi(
    page,
    snap('not_started'),
    () => ({ status: 202, body: snap('queued', { preprocessing: pre() }) }),
    [processing(0.3, fresh()), completed()],
  );
  await page.goto(`/recordings/${REC_ID}`);
  await expect(card(page).getByText('Not started', { exact: true })).toBeVisible();
  await card(page).getByRole('button', { name: 'Start processing' }).click();
  await expect(card(page).getByText('Queued', { exact: true })).toBeVisible();
  await expect(card(page).getByText('Processing · Decoding', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(card(page).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  await expect(card(page).getByText('Completed', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByText(/Sample-accurate/)).toBeVisible();
  await expect(card(page).getByRole('button')).toHaveCount(0);
});

const STATES: [string, unknown][] = [
  ['not started', snap('not_started')],
  ['validating', snap('validating')],
  ['queued', snap('queued', { preprocessing: pre() })],
  ['processing', processing(0.5, fresh())],
  ['processing, unknown fraction', processing(null)],
  ['completed', completed()],
  ['failed', failed()],
  ['cancelled', cancelled()],
  [
    'rejected recording',
    snap('failed', { recording: { status: 'invalid', validationError: 'CORRUPT_MEDIA' } }),
  ],
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
        await expect(card(page).getByLabel('Processing details')).toBeVisible();
        await expectNoBlockingViolations(page);
      });
    }
  });
}
