import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real stack: web (Vite) → API → Postgres/Redis/local storage.
 * Prerequisites: `pnpm infra:up && pnpm db:migrate && pnpm db:seed` (see docs/development/SETUP.md).
 * The API and web dev server are started here unless already running.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @vip/api run build && pnpm --filter @vip/api run start',
      cwd: '../..',
      url: 'http://127.0.0.1:3000/api/v1/health/ready',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @vip/web run dev',
      cwd: '../..',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
