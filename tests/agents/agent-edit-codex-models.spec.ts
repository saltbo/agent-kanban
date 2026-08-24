import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function runSql(sql: string): string {
  return execFileSync("sqlite3", ["-cmd", ".timeout 10000", d1DatabasePath(), sql], { encoding: "utf8" }).trim();
}

test.describe("Agent edit — codex model catalog", () => {
  test("lists all machine-reported codex models and preserves thinking effort across model changes", async ({ page }) => {
    // 1. Sign up and land on a board
    const email = `codex_models_${Date.now()}@example.com`;
    await signUpAndGetBoard(page, email);

    // 2. Resolve the signed-in user's id (machines.owner_id) from the user table
    const ownerId = runSql(`SELECT id FROM user WHERE email = '${sqlString(email)}';`);
    if (!ownerId) throw new Error(`No user row found for ${email}`);

    // 3. Seed an online machine reporting three codex models with distinct reasoning efforts
    const now = new Date().toISOString();
    const machineId = `mach-codex-e2e-${Date.now()}`;
    const runtimes = JSON.stringify([
      {
        name: "codex",
        status: "ready",
        checked_at: now,
        models: [
          { id: "gpt-e2e-alpha", name: "GPT E2E Alpha", supported_reasoning_efforts: ["low", "medium", "high"] },
          { id: "gpt-e2e-beta", name: "GPT E2E Beta", supported_reasoning_efforts: ["low", "medium", "high", "xhigh"] },
          { id: "gpt-e2e-gamma", name: "GPT E2E Gamma", supported_reasoning_efforts: ["low"] },
        ],
      },
    ]);
    runSql(
      `INSERT INTO machines (id, owner_id, device_id, name, status, os, version, runtimes, last_heartbeat_at, created_at)
       VALUES ('${machineId}', '${sqlString(ownerId)}', 'device-codex-e2e-${Date.now()}', 'E2E Machine', 'online', 'linux', 'e2e',
               '${sqlString(runtimes)}', '${now}', '${now}');`,
    );

    // 4. Create a codex worker agent pinned to the alpha model
    const agentId = await page.evaluate(async () => {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("auth-token")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Codex E2E",
          username: `codex-e2e-${Date.now()}`,
          kind: "worker",
          runtime: "codex",
          model: "gpt-e2e-alpha",
        }),
      });
      if (!response.ok) throw new Error(`Failed to create agent: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { id: string }).id;
    });

    // 5. Open the edit page
    await page.goto(`/agents/${agentId}/edit`);
    await expect(page.getByRole("heading", { name: "Edit agent" })).toBeVisible();

    // 6. Model dropdown lists exactly the three machine-reported models
    const modelTrigger = page.locator("#edit-agent-model");
    await modelTrigger.click();
    await expect(page.getByRole("option")).toHaveCount(3);
    await expect(page.getByRole("option", { name: /GPT E2E Alpha/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /GPT E2E Beta/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /GPT E2E Gamma/ })).toBeVisible();

    // 7. Select GPT E2E Alpha, then set Thinking effort to High
    await page.getByRole("option", { name: /GPT E2E Alpha/ }).click();
    await expect(modelTrigger).toContainText("GPT E2E Alpha");
    const reasoningTrigger = page.locator("#edit-agent-reasoning");
    await reasoningTrigger.click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(reasoningTrigger).toContainText("High");

    // 8. Switch to GPT E2E Beta (also supports high) — effort must be preserved
    await modelTrigger.click();
    await page.getByRole("option", { name: /GPT E2E Beta/ }).click();
    await expect(modelTrigger).toContainText("GPT E2E Beta");
    await expect(reasoningTrigger).toContainText("High");

    // 9. Switch to GPT E2E Gamma (supports only low) — effort resets to Provider default
    await modelTrigger.click();
    await page.getByRole("option", { name: /GPT E2E Gamma/ }).click();
    await expect(modelTrigger).toContainText("GPT E2E Gamma");
    await expect(reasoningTrigger).toContainText("Provider default");
  });
});
