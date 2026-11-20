import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * Automated accessibility checks (ADR-0029): every screen, both themes, desktop and mobile
 * projects. Budget: no serious or critical violations. Automated checks cover only part of
 * WCAG 2.2 AA; keyboard and screen-reader walkthroughs remain part of acceptance.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function expectNoBlockingViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

const SCREENS: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    name: 'dashboard',
    path: '/',
    ready: (p) => expect(p.getByRole('heading', { name: 'Overview' })).toBeVisible(),
  },
  {
    name: 'recordings',
    path: '/recordings',
    ready: (p) => expect(p.getByRole('heading', { name: 'Recordings', level: 1 })).toBeVisible(),
  },
  {
    name: 'upload',
    path: '/recordings/new',
    ready: (p) => expect(p.getByRole('heading', { name: 'Upload recording' })).toBeVisible(),
  },
  {
    name: 'not-found',
    path: '/this-page-does-not-exist',
    ready: (p) =>
      expect(p.getByRole('heading', { name: 'Page not found', level: 1 })).toBeVisible(),
  },
];

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
    });

    for (const screen of SCREENS) {
      test(`${screen.name} has no serious or critical violations`, async ({ page }) => {
        await page.goto(screen.path);
        await screen.ready(page);
        await page.waitForLoadState('networkidle');
        await expectNoBlockingViolations(page);
      });
    }

    test('recording detail has no serious or critical violations', async ({ page }) => {
      await page.goto('/recordings');
      await expect(page.getByRole('heading', { name: 'Recordings', level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const firstRecording = page.locator('table a[href^="/recordings/"]').first();
      test.skip((await firstRecording.count()) === 0, 'No recordings in the development database');
      await firstRecording.click();
      await expect(page.getByText('Recording details')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectNoBlockingViolations(page);
    });

    test('mobile navigation sheet has no serious or critical violations', async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'mobile', 'The navigation sheet exists on mobile only');
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoBlockingViolations(page);
    });
  });
}
