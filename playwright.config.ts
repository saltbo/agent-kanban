import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.VITE_DEV_PORT) || 6265;
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // E2E fixtures seed the single local Miniflare D1 database directly. Keep one
  // worker so the app and sqlite fixture writes never contend for that file.
  workers: 1,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm db:migrate && pnpm exec vite dev --config vite.e2e.config.ts --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    env: { VITE_DEV_PORT: String(port) },
  },
});
