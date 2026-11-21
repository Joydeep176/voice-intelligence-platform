import { expect, type Page, test } from '@playwright/test';

/**
 * Cross-route navigation (Phase 2A M3-M8) against the live stack. Strictly read-only: uses existing
 * recordings and never uploads, deletes or edits data.
 */
const MISSING = '99999999-9999-4999-8999-999999999999';
const h1 = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

test.describe('journey', () => {
  test.skip(({ isMobile }) => isMobile, 'The sidebar journey runs on the desktop project');

  test('Dashboard to Recordings to detail to Report to Evidence and back, then Reports and Pipeline', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(h1(page, 'Overview')).toBeVisible();

    await mainNav(page).getByRole('link', { name: 'Recordings' }).click();
    await expect(page).toHaveURL(/\/recordings$/);
    await expect(h1(page, 'Recordings')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const first = page.locator('table a[href^="/recordings/"]').first();
    test.skip((await first.count()) === 0, 'No recordings in the development database');
    await first.click();
    await expect(page.getByText('Recording details')).toBeVisible();
    const detailUrl = page.url();
    const filename = (await page.getByRole('heading', { level: 1 }).first().innerText()).trim();

    await page.getByRole('link', { name: 'Open report workspace' }).click();
    await expect(page).toHaveURL(/\/recordings\/[^/]+\/report$/);
    await expect(h1(page, 'Report')).toBeVisible();
    await expect(page.getByText('Not generated').first()).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page
      .getByRole('link', { name: /evidence/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/recordings\/[^/]+\/evidence$/);
    await expect(h1(page, 'Evidence')).toBeVisible();
    await expect(page.getByText('Not available').first()).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Reports' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.goBack();
    await expect(h1(page, 'Report')).toBeVisible();

    await mainNav(page).getByRole('link', { name: 'Reports' }).click();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(h1(page, 'Reports')).toBeVisible();
    await page.waitForLoadState('networkidle');

    const search = page.getByRole('searchbox', { name: /search reports/i });
    await search.fill('zzz-no-such-recording-zzz');
    await expect(page.getByText('No recordings match').first()).toBeVisible();
    await search.fill(filename);
    const matches = page.getByRole('link', { name: `Open report for ${filename}`, exact: true });
    test.skip((await matches.count()) !== 1, 'Filename is not unique; cannot map to one id');
    const open = matches.first();
    await expect(open).toBeVisible();
    await open.click();
    await expect(page).toHaveURL(/\/recordings\/[^/]+\/report$/);
    expect(page.url().split('/')[4]).toBe(detailUrl.split('/')[4]);

    await mainNav(page).getByRole('link', { name: 'Pipeline' }).click();
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(h1(page, 'Pipeline')).toBeVisible();
    await expect(mainNav(page).getByRole('link', { name: 'Pipeline' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

test.describe('not found and theme', () => {
  for (const kind of ['report', 'evidence'] as const) {
    test(`unknown recording id on ${kind} shows "Recording not found"`, async ({ page }) => {
      await page.goto(`/recordings/${MISSING}/${kind}`);
      await expect(page.getByText('Recording not found')).toBeVisible();
    });
  }

  test('a malformed recording id is a not-found page', async ({ page }) => {
    await page.goto('/recordings/not-a-uuid/report');
    await expect(h1(page, 'Page not found')).toBeVisible();
  });

  test('the chosen theme persists across routes and reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(h1(page, 'Overview')).toBeVisible();
    await page.getByRole('button', { name: 'Change theme' }).first().click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // Client-side navigation keeps the shell and the theme.
    await page.evaluate(
      "window.history.pushState(null, '', '/pipeline'); window.dispatchEvent(new PopStateEvent('popstate'))",
    );
    await expect(h1(page, 'Pipeline')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);

    await page.goto('/reports');
    await expect(h1(page, 'Reports')).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/dark/);
    expect(await page.evaluate(() => localStorage.getItem('vip-theme'))).toBe('dark');
  });
});
