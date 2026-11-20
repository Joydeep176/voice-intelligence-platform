import { expect, type Page, test } from '@playwright/test';

/**
 * Dashboard (Phase 2A M2) against the live stack. Strictly read-only: this spec never uploads,
 * deletes or otherwise creates data, so the development database is preserved.
 */
const isHeroScene = (url: string) => /hero-scene/.test(url);

function trackHeroScene(page: Page) {
  const requests: Array<{ url: string; startedAt: number }> = [];
  page.on('request', (r) => {
    if (isHeroScene(r.url())) requests.push({ url: r.url(), startedAt: Date.now() });
  });
  return requests;
}

async function openDashboard(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
}

test.describe('dashboard content', () => {
  test.skip(({ isMobile }) => isMobile, 'Content checks run on the desktop project');

  test('renders sections with live data and labelled health rows', async ({ page }) => {
    await openDashboard(page);
    for (const name of ['Recent recordings', 'System health', 'What the platform does today']) {
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    }
    await expect(page.getByRole('region', { name: 'Summary' })).toBeVisible();
    const health = page
      .getByRole('heading', { name: 'System health' })
      .locator('xpath=ancestor::*[@data-slot="card"][1]');
    for (const label of ['API', 'Database', 'Job queue', 'Audio service']) {
      await expect(health.getByText(label, { exact: true })).toBeVisible();
    }
    // Wait for the first response; each row then carries text, not colour alone.
    await expect(health.getByText('Checking…')).toHaveCount(0);
    await expect(health.getByText(/Healthy|Unavailable|Not checked/).first()).toBeVisible();
  });

  test('opens the recording detail page from the first recent recording', async ({ page }) => {
    await openDashboard(page);
    const recent = page
      .getByRole('heading', { name: 'Recent recordings' })
      .locator('xpath=ancestor::*[@data-slot="card"][1]');
    await expect(recent.getByRole('status')).toHaveCount(0); // skeleton gone
    const first = recent.locator('a[href^="/recordings/"]').first();
    test.skip((await first.count()) === 0, 'No recordings in the development database');
    const href = await first.getAttribute('href');
    await first.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByText('Recording details')).toBeVisible();
  });

  test('keyboard: Tab from the skip link reaches Upload recording with a visible focus indicator', async ({
    page,
  }) => {
    await openDashboard(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    const target = page.locator('#main').getByRole('link', { name: 'Upload recording' }).first();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await target.evaluate((el) => el === el.ownerDocument.activeElement);
    }
    expect(reached, 'Upload recording is reachable by Tab').toBe(true);
    await expect(target).toBeFocused();
    const indicator = await target.evaluate((el) => {
      const s = el.ownerDocument.defaultView!.getComputedStyle(el);
      return { outline: parseFloat(s.outlineWidth), shadow: s.boxShadow };
    });
    expect(indicator.outline > 0 || (indicator.shadow !== '' && indicator.shadow !== 'none')).toBe(
      true,
    );
  });
});

test.describe('3D hero gating', () => {
  test('mobile: never requests the 3D scene and renders no canvas', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Mobile project only');
    const requests = trackHeroScene(page);
    await openDashboard(page);
    await page.waitForLoadState('load');
    await page.waitForTimeout(3500);
    expect(requests).toEqual([]);
    await expect(page.locator('canvas')).toHaveCount(0);
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('desktop: never requests the 3D scene and renders no canvas', async ({
      page,
    }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'Desktop project only');
      const requests = trackHeroScene(page);
      await openDashboard(page);
      await page.waitForLoadState('load');
      await page.waitForTimeout(3500);
      expect(requests).toEqual([]);
      await expect(page.locator('canvas')).toHaveCount(0);
    });
  });

  test('desktop default: any 3D request starts after first contentful paint; canvas is aria-hidden', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Desktop project only');
    const requests = trackHeroScene(page);
    await openDashboard(page);
    await page.waitForLoadState('load');
    await page.waitForTimeout(4000); // idle callback timeout is 2 s
    const fcpEpoch = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return fcp ? performance.timeOrigin + fcp.startTime : null;
    });
    expect(fcpEpoch, 'first contentful paint was recorded').not.toBeNull();
    if (requests.length > 0) {
      expect(requests[0]!.startedAt).toBeGreaterThan(fcpEpoch!);
      const canvas = page.locator('canvas');
      await expect(canvas.first()).toHaveAttribute('aria-hidden', 'true');
    } else {
      // WebGL unavailable in this browser: the 2D visual is the complete experience.
      await expect(page.locator('canvas')).toHaveCount(0);
    }
    await expect(
      page.locator('[data-dashboard-hero] svg[aria-hidden="true"]').first(),
    ).toBeAttached();
  });
});
