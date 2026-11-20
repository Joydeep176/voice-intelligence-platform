import { expect, test } from '@playwright/test';
import { syntheticWav } from './synthetic-wav';

const SHOTS = 'test-results/screenshots';

test('uploads a synthetic recording and shows it with an honest processing status', async ({
  page,
}, testInfo) => {
  const name = `e2e-synthetic-${testInfo.project.name}-${Date.now()}.wav`;
  // 20 s of 16 kHz mono PCM (~640 KB). Set UPLOAD_PART_SIZE_BYTES below that to exercise
  // multiple parts; the flow is identical either way.
  const wav = syntheticWav(20_000);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText('Development workspace')).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/${testInfo.project.name}-01-dashboard.png`,
    fullPage: true,
  });

  await page
    .getByRole('link', { name: /upload recording/i })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Upload recording' })).toBeVisible();

  await page.getByLabel('Audio file').setInputFiles({ name, mimeType: 'audio/wav', buffer: wav });
  const submit = page.getByRole('button', { name: 'Upload', exact: true });
  await expect(submit).toBeDisabled(); // consent not yet given
  await page.getByRole('checkbox').check();
  await page.screenshot({
    path: `${SHOTS}/${testInfo.project.name}-02-upload-ready.png`,
    fullPage: true,
  });
  await submit.click();

  await expect(page.getByRole('heading', { name: /upload complete/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/has not been transcribed or analysed/i)).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/${testInfo.project.name}-03-upload-complete.png`,
    fullPage: true,
  });

  await page.getByRole('link', { name: 'View recording' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Uploaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Not started')).toBeVisible();
  await expect(page.getByText('Not yet determined')).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/${testInfo.project.name}-04-recording-detail.png`,
    fullPage: true,
  });

  // Persisted: it appears in the library after a full reload.
  await page.goto('/recordings');
  await expect(page.getByRole('link', { name })).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/${testInfo.project.name}-05-library.png`,
    fullPage: true,
  });
});

test('renders the dashboard in dark mode', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One dark-mode capture is enough');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-06-dashboard-dark.png`, fullPage: true });
});

test('hides another workspace behind a not-found state', async ({ page }) => {
  await page.goto('/recordings/6f1c1f9e-6a3e-4c55-9a4e-2f1f2d0f7b10');
  await expect(page.getByText('Recording not found')).toBeVisible();
});
