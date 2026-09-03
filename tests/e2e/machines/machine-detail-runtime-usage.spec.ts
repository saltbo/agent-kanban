import { expect, test } from "@playwright/test";
import { signInWithRealmrootSession } from "../../helpers/auth";

test("[spec: machines/runner-aggregation] Machine detail keeps runtime usage grouped by Runner", async ({ page }) => {
  await page.route(/\/api\/machines\/environment-build-01$/, async (route) => {
    await route.fulfill({
      json: {
        id: "environment-build-01",
        name: "mac-mini-build",
        description: "Local build runners",
        status: "online",
        currentLoad: 2,
        maxLoad: 5,
        runnerCount: 2,
        runners: [
          {
            id: "runner-east-id",
            name: "runner-east",
            status: "active",
            currentLoad: 1,
            maxLoad: 2,
            runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
            runtimeUsage: [
              {
                runtime: "codex",
                windows: [{ label: "5-hour window", utilization: 25, resetsAt: "2026-09-03T18:00:00.000Z" }],
              },
            ],
            lastHeartbeatAt: "2026-09-03T12:00:00.000Z",
          },
          {
            id: "runner-west-id",
            name: "runner-west",
            status: "active",
            currentLoad: 1,
            maxLoad: 3,
            runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
            runtimeUsage: [
              {
                runtime: "codex",
                windows: [{ label: "5-hour window", utilization: 80, resetsAt: "2026-09-03T19:00:00.000Z" }],
              },
            ],
            lastHeartbeatAt: "2026-09-03T12:01:00.000Z",
          },
        ],
        runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
        lastHeartbeatAt: "2026-09-03T12:01:00.000Z",
        createdAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-03T12:01:00.000Z",
      },
    });
  });
  await signInWithRealmrootSession(page, `machine_usage_${Date.now()}@example.com`);

  // 1. Open the Machine detail page.
  await page.goto("/machines/environment-build-01");

  // 2. Inspect each Runner's runtime usage independently.
  const eastRunner = page.getByRole("region", { name: "runner-east" });
  const westRunner = page.getByRole("region", { name: "runner-west" });
  await expect(eastRunner.getByRole("heading", { name: "codex" })).toBeVisible();
  await expect(eastRunner.getByText("25% used · 75% remaining", { exact: true })).toBeVisible();
  await expect(eastRunner.getByRole("progressbar", { name: "codex 5-hour window usage" })).toHaveAttribute("aria-valuenow", "25");
  await expect(eastRunner.getByText("80% used · 20% remaining", { exact: true })).toHaveCount(0);

  await expect(westRunner.getByRole("heading", { name: "codex" })).toBeVisible();
  await expect(westRunner.getByText("80% used · 20% remaining", { exact: true })).toBeVisible();
  await expect(westRunner.getByRole("progressbar", { name: "codex 5-hour window usage" })).toHaveAttribute("aria-valuenow", "80");
  await expect(westRunner.getByText("25% used · 75% remaining", { exact: true })).toHaveCount(0);
});
