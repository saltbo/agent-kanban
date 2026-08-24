import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto("/auth");
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.locator('input[placeholder="Name"]').fill("Test User");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("password123");
  await page.getByRole("button", { name: "Sign Up" }).click();
  await page.waitForFunction(() => Boolean(localStorage.getItem("auth-token")));
}

const now = "2026-05-04T12:00:00.000Z";

const task = {
  id: "task-card-chat",
  board_id: "board-card-chat",
  seq: 7,
  status: "todo",
  title: "Open card chat from assigned agent",
  description: "Verify card click targets.",
  repository_id: null,
  repository_name: null,
  labels: [],
  created_by: "test",
  assigned_to: "agent-card-chat",
  agent_name: "CardChatAgent",
  agent_public_key: "card-chat-agent-public-key",
  active_session_id: null,
  result: null,
  pr_url: null,
  input: null,
  created_from: null,
  scheduled_at: null,
  position: 0,
  created_at: now,
  updated_at: now,
  blocked: false,
  depends_on: [],
  subtask_count: 0,
  duration_minutes: null,
  notes: [
    {
      id: "note-created",
      task_id: "task-card-chat",
      actor_type: "user",
      actor_id: "test",
      actor_name: "Test User",
      actor_public_key: null,
      action: "created",
      detail: null,
      session_id: null,
      created_at: now,
    },
  ],
};

const board = {
  id: "board-card-chat",
  name: "Card Chat Board",
  description: null,
  type: "ops",
  visibility: "private",
  share_slug: null,
  task_seq: 7,
  created_at: now,
  updated_at: now,
  tasks: [task],
};

test.describe("Board Page", () => {
  test("task card opens detail and assigned agent click opens chat", async ({ page }) => {
    await signUp(page, `cardchat_${Date.now()}@example.com`);

    await page.route("**/api/boards/*", async (route) => {
      await route.fulfill({ json: board });
    });
    await page.route("**/api/tasks/task-card-chat", async (route) => {
      await route.fulfill({ json: task });
    });
    await page.route("**/api/tasks/task-card-chat/stream?*", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: ":\n\n",
      });
    });
    await page.route("**/api/tasks/task-card-chat/notes", async (route) => {
      await route.fulfill({ json: task.notes });
    });
    await page.route("**/api/tasks/task-card-chat/messages", async (route) => {
      await route.fulfill({ json: [] });
    });
    await page.route("**/api/repositories", async (route) => {
      await route.fulfill({ json: [] });
    });

    await page.goto("/boards/board-card-chat");

    const card = page.locator('[data-task-id="task-card-chat"]').first();
    await expect(card).toBeVisible();

    await card.getByText("Open card chat from assigned agent").click();
    const detailSheet = page.locator('[data-slot="dialog-content"]').filter({ hasText: "Verify card click targets." });
    await expect(detailSheet).toBeVisible();
    await expect(detailSheet.getByText("Activity")).toBeVisible();
    await detailSheet.getByRole("button", { name: "✕" }).click();
    await expect(detailSheet).not.toBeVisible();

    await card.locator("[data-agent-section]").click();
    const chatSheet = page.locator('[data-slot="sheet-content"]').filter({ hasText: "Chat history is not available for this task." });
    await expect(chatSheet).toBeVisible();
    await expect(chatSheet.locator("span").filter({ hasText: "CardChatAgent" })).toBeVisible();
    await expect(page.locator('[data-slot="dialog-content"]').filter({ hasText: "No activity yet." })).not.toBeVisible();
  });
});
