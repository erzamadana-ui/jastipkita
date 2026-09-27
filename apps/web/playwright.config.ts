import { defineConfig, devices } from '@playwright/test';

// Smoke tests against the BUILT site (run `pnpm build` first). The API is intentionally unreachable in CI,
// which exercises the offline/"segera hadir" fallbacks. Chromium comes from PLAYWRIGHT_BROWSERS_PATH.
const PORT = 4322;
export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node scripts/serve-dist.mjs --port ${PORT}`,
    url: `http://localhost:${PORT}/jastipkita/`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
