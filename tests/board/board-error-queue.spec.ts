import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const now = "2026-08-24T08:00:00.000Z";

const failedAction = {
  id: "action-error-queue",
  task_id: "task-error-queue",
  actor_type: "machine",
  actor_id: "machine-error-queue",
  actor_name: "Local runtime",
  actor_public_key: null,
  action: "failed",
  detail: JSON.stringify({
    category: "provider",
    code: "upstream_unavailable",
    message: "Provider connection closed before the task reached review.",
    retryable: true,
  }),
  session_id: "session-error-queue",
  created_at: now,
};

const errorTask = {
  id: "task-error-queue",
  board_id: "board-error-queue",
  board_type: "dev",
  seq: 12,
  status: "error",
  title: "Preserve workspace after provider failure",
  description: "The runtime stopped before submitting the task for review.",
  repository_id: null,
  repository_name: null,
  labels: [],
  created_by: "test",
  assigned_to: "agent-error-queue",
  agent_name: "RecoveryAgent",
  agent_public_key: "error-queue-agent-public-key",
  active_session_id: "session-error-queue",
  result: null,
  pr_url: null,
  input: null,
  metadata: {},
  created_from: null,
  scheduled_at: null,
  position: 0,
  created_at: now,
  updated_at: now,
  blocked: false,
  depends_on: [],
  subtask_count: 0,
  duration_minutes: null,
  notes: [failedAction],
};

const board = {
  id: "board-error-queue",
  name: "Error Queue Board",
  description: null,
  type: "dev",
  labels: [],
  visibility: "private",
  share_slug: null,
  task_seq: 12,
  created_at: now,
  updated_at: now,
  tasks: [errorTask],
};

const taskError = {
  id: "task-error-record",
  task_id: errorTask.id,
  session_id: "session-error-queue",
  runtime: "claude-code",
  category: "provider",
  code: "upstream_unavailable",
  message: "Provider connection closed before the task reached review.",
  http_status: 503,
  retryable: true,
  reset_at: null,
  created_at: now,
  resolved_at: null,
};

test.describe("Board error queue", () => {
  test("shows failed tasks in a read-only Error column with runtime details", async ({ page }) => {
    await signUpAndGetBoard(page, `errorqueue_${Date.now()}@example.com`, "Error Queue User");

    await page.route("**/api/boards/board-error-queue", async (route) => {
      await route.fulfill({ json: board });
    });
    await page.route("**/api/tasks/task-error-queue", async (route) => {
      await route.fulfill({ json: errorTask });
    });
    await page.route("**/api/tasks/task-error-queue/errors", async (route) => {
      await route.fulfill({ json: [taskError] });
    });
    await page.route("**/api/tasks/task-error-queue/stream?*", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: ":\n\n",
      });
    });
    await page.route("**/api/repositories", async (route) => {
      await route.fulfill({ json: [] });
    });

    await page.goto("/boards/board-error-queue");

    const columnGrid = page.locator(".hidden.md\\:grid");
    await expect(columnGrid).toBeVisible();
    await expect(columnGrid.locator(":scope > div")).toHaveCount(6);

    const errorColumn = columnGrid.locator('[data-column-status="error"]');
    await expect(errorColumn).toBeVisible();
    await expect(errorColumn.getByText("Error", { exact: true })).toBeVisible();
    await expect(errorColumn.locator('[data-task-id="task-error-queue"]')).toBeVisible();
    await expect(errorColumn.getByText("Preserve workspace after provider failure")).toBeVisible();

    await errorColumn.getByText("Preserve workspace after provider failure").click();

    const detailSheet = page.locator('[data-slot="sheet-content"]').filter({ hasText: "The runtime stopped before submitting the task for review." });
    await expect(detailSheet).toBeVisible();
    await expect(detailSheet.getByText("Error", { exact: true })).toBeVisible();

    const runtimeError = detailSheet.getByRole("status");
    await expect(runtimeError).toContainText("Runtime error");
    await expect(runtimeError).toContainText("provider");
    await expect(runtimeError).toContainText("Provider connection closed before the task reached review.");
    await expect(runtimeError).toContainText("upstream_unavailable");
    await expect(runtimeError).toContainText("Workspace and branch are preserved.");

    await expect(detailSheet.getByRole("button", { name: /retry/i })).toHaveCount(0);
    await expect(detailSheet.getByText("moved this task to the error queue")).toBeVisible();
  });
});
