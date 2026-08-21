import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const WORKER_RUNTIME_LABELS = ["Claude Code", "Codex CLI", "Gemini CLI", "GitHub Copilot", "Hermes", "AMA Cloud"];

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

test.describe("Agent runtime options", () => {
  test("leaders cannot be edited while workers retain worker-only runtime options", async ({ page }) => {
    await signUpAndGetBoard(page, `agent_runtimes_${Date.now()}@example.com`);

    const leaderId = await page.evaluate(async () => {
      const session = await fetch("/api/auth/session", { credentials: "include" }).then((response) => response.json());
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": session.session.csrfToken,
        },
        body: JSON.stringify({
          name: "OpenCode Leader",
          username: `opencode-leader-${Date.now()}`,
          kind: "leader",
          runtime: "opencode",
          realmroot_agent_id: `rr-agent-leader-${Date.now()}`,
          realmroot_credential_ref: `ama://vaults/e2e/credentials/leader-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error(`Failed to create leader: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { id: string }).id;
    });

    const workerId = await page.evaluate(async () => {
      const session = await fetch("/api/auth/session", { credentials: "include" }).then((response) => response.json());
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": session.session.csrfToken,
        },
        body: JSON.stringify({
          name: "Claude Worker",
          username: `claude-worker-${Date.now()}`,
          kind: "leader",
          runtime: "pi",
          realmroot_agent_id: `rr-agent-worker-${Date.now()}`,
          realmroot_credential_ref: `ama://vaults/e2e/credentials/worker-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error(`Failed to seed worker identity: ${response.status} ${await response.text()}`);
      return ((await response.json()) as { id: string }).id;
    });
    execFileSync("sqlite3", [
      "-cmd",
      ".timeout 10000",
      d1DatabasePath(),
      `UPDATE agents SET kind = 'worker', runtime = 'claude' WHERE id = '${workerId}';`,
    ]);

    await page.goto("/agents");
    const leaderCard = page.getByRole("link", { name: /OpenCode Leader/ });
    await expect(leaderCard).toBeVisible();
    await expect(leaderCard.getByText("Leader", { exact: true })).toBeVisible();
    await expect(leaderCard).not.toContainText("Not schedulable");

    await page.goto(`/agents/${leaderId}`);
    await expect(page.getByRole("heading", { name: "OpenCode Leader" })).toBeVisible();
    await expect(page.getByText("Leader", { exact: true })).toBeVisible();
    await expect(page.getByText("Not schedulable", { exact: true })).toHaveCount(0);

    await page.locator("div.absolute.top-4.right-4").getByRole("button").click();
    await expect(page.getByRole("menuitem", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();

    await page.goto(`/agents/${leaderId}/edit`);
    await expect(page).toHaveURL(`/agents/${leaderId}`);
    await expect(page.getByRole("heading", { name: "OpenCode Leader" })).toBeVisible();

    await page.goto(`/agents/${workerId}`);
    await expect(page.getByRole("heading", { name: "Claude Worker" })).toBeVisible();
    await page.locator("div.absolute.top-4.right-4").getByRole("button").click();
    const editItem = page.getByRole("menuitem", { name: "Edit", exact: true });
    await expect(editItem).toBeVisible();
    await editItem.click();
    await expect(page).toHaveURL(`/agents/${workerId}/edit`);
    await expect(page.getByRole("heading", { name: "Edit agent" })).toBeVisible();

    const workerRuntime = page.getByRole("group", { name: "Runtime" }).locator('[data-slot="select-trigger"]');
    await workerRuntime.click();
    await expect(page.getByRole("option")).toHaveText(WORKER_RUNTIME_LABELS);
  });
});
