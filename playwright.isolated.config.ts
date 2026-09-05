import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

if (!process.env.AK_E2E_PORT) {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("Failed to allocate E2E port");
  process.env.AK_E2E_PORT = String(address.port);
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
}
const port = Number(process.env.AK_E2E_PORT);
const stateDir = process.env.AK_E2E_STATE_DIR ?? mkdtempSync(join(tmpdir(), "ak-e2e-"));
process.env.AK_E2E_STATE_DIR = stateDir;
const baseURL = `http://localhost:${port}`;
const wranglerConfig = join(stateDir, "wrangler.json");
writeFileSync(
  wranglerConfig,
  JSON.stringify({
    name: "agent-kanban-e2e",
    main: join(import.meta.dirname, "server/worker/index.ts"),
    compatibility_date: "2026-04-13",
    compatibility_flags: ["nodejs_compat"],
    assets: { binding: "ASSETS", not_found_handling: "single-page-application" },
    vars: {
      AK_PUBLIC_ORIGIN: baseURL,
      OIDC_ISSUER: "https://issuer.example.test",
      OIDC_WEB_CLIENT_ID: "ak-e2e",
      OIDC_WEB_CLIENT_SECRET: "local-test-only",
      AK_SESSION_ENCRYPTION_KEY: Buffer.from("01234567890123456789012345678901").toString("base64"),
      AK_SIGNING_KEY: Buffer.from("01234567890123456789012345678901").toString("base64"),
      AGENCY_ORIGIN: "https://agency.example.test",
    },
    d1_databases: [{ binding: "DB", database_name: "agent-kanban-e2e", database_id: "13cdf435-a99c-4744-9eca-9ed22b232581" }],
  }),
);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: "list",
  globalTeardown: "./tests/e2e/support/cleanup.ts",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec tsx tests/e2e/support/migrate.ts && pnpm exec vite dev --config vite.e2e.config.ts --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: {
      AK_E2E_STATE_DIR: stateDir,
      AK_E2E_WRANGLER_CONFIG: wranglerConfig,
      VITE_DEV_PORT: String(port),
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
    timeout: 120_000,
  },
});
