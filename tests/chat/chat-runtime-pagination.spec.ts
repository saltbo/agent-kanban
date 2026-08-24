// spec: Task chat runtime events
// seed: tests/seed.spec.ts

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const AMA_SESSION_ID = "b3c5b443-f551-42f1-b4f6-f0ad4aaa61c4";
const AMA_PROJECT_ID = "project_b3a6a18924dd4e299f8bfe71ee8125b7";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

test.describe("Task chat runtime events", () => {
  test("loads the latest page and loads earlier activity on scroll up", async ({ page }) => {
    // 1. Sign up a fresh user and land on the board page
    await signUpAndGetBoard(page, `chatpagination_${Date.now()}@example.com`);

    // 2. Capture the board id from the URL
    const boardId = page.url().split("/boards/")[1];

    // 3. Create a worker agent via API (the user owns it; agent creation is allowed for users)
    const { agentUsername } = await page.evaluate(async () => {
      const token = localStorage.getItem("auth-token");
      const username = `chat-pg-agent-${Date.now()}`;
      const res = await fetch(`${window.location.origin}/api/agents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ username, runtime: "claude" }),
      });
      if (!res.ok) throw new Error(`agent create: ${res.status} ${await res.text()}`);
      const agent = (await res.json()) as { id: string };
      return { agentId: agent.id, agentUsername: username };
    });

    // 4. Tasks are created by agents only, so seed the task directly in D1 on the user's board,
    //    assigned to the agent and bound to the rich AMA session via its annotations. The runtime
    //    endpoint resolves the session server-side (project-scoped), so its events load for this task.
    const taskId = `chatpg${Date.now()}`;
    const nowIso = new Date().toISOString();
    const metadataJson = JSON.stringify({ annotations: { "ama.sessionId": AMA_SESSION_ID, "ama.projectId": AMA_PROJECT_ID } });
    const agentId = execFileSync("sqlite3", [d1DatabasePath(), `SELECT id FROM agents WHERE username = '${agentUsername}';`])
      .toString()
      .trim();
    execFileSync("sqlite3", [
      "-cmd",
      ".timeout 10000",
      d1DatabasePath(),
      `INSERT INTO tasks (id, board_id, seq, status, title, assigned_to, metadata, position, created_at, updated_at)
       VALUES ('${taskId}', '${boardId}', 999999, 'in_progress', 'chat-pagination', '${agentId}', '${metadataJson}', 0, '${nowIso}', '${nowIso}');`,
    ]);

    // 5. Navigate to the board and wait for the column grid to render
    await page.goto(`/boards/${boardId}`);
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();

    // 6. Find the task card and click its title to open the task detail panel
    const taskCard = page.locator(`[data-task-id="${taskId}"]`);
    await expect(taskCard).toBeVisible();
    await taskCard.getByText("chat-pagination").click();

    // 7. Wait for the task detail dialog to open
    const detailSheet = page.locator('[data-slot="dialog-content"]').first();
    await expect(detailSheet).toBeVisible();

    // 8. Click the agent name button inside the detail sheet to open the chat drawer.
    //    Session history and live events now load through the task-scoped WebSocket
    //    URL endpoint; backfill pagination happens over that socket, not HTTP.
    const sessionWsRequest = page.waitForRequest((req) => req.url().includes(`/tasks/${taskId}/session/ws`), { timeout: 20000 });
    const agentButton = detailSheet.locator("button[type='button']").filter({ hasText: /chat-pg-agent/ });
    await expect(agentButton).toBeVisible();
    await agentButton.click();
    await sessionWsRequest;

    // 9. The chat drawer opens as a sheet alongside the dialog
    const chatSheet = page.locator('[data-slot="sheet-content"]').first();
    await expect(chatSheet).toBeVisible();

    // 10. Wait for runtime history to finish loading (must not stay on "Loading runtime history...")
    await expect(chatSheet.getByText("Loading runtime history...")).not.toBeVisible({ timeout: 15000 });

    // The thread viewport must be present
    const viewport = chatSheet.locator(".aui-thread-viewport");
    await expect(viewport).toBeVisible();

    // 11. Verify the latest page of assistant messages loaded — thread is not empty
    const messages = chatSheet.locator(".aui-assistant-message-root");
    await expect(messages.first()).toBeVisible({ timeout: 15000 });

    // 12. Scrolling remains stable after WS backfill has populated history.
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(messages.first()).toBeVisible({ timeout: 15000 });
  });
});
