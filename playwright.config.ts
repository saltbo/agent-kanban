import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.AK_E2E_PORT ?? "6265");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/v2/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `node tests/v2/helpers/e2e-server.mjs --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
