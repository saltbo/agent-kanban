import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const now = "2026-08-24T08:00:00.000Z";

async function openReviewTask(page: Page, action: "reject" | "complete") {
  await signUpAndGetBoard(page, `reviewactions_${action}_${Date.now()}@example.com`);

  const boardId = new URL(page.url()).pathname.split("/").at(-1)!;
  const taskId = `task-review-${action}`;
  const taskTitle = `${action === "reject" ? "Reject" : "Complete"} review task`;
  let task = {
    id: taskId,
    board_id: boardId,
    board_type: "dev",
    seq: 1,
    status: "in_review",
    title: taskTitle,
    description: "A task waiting for a reviewer decision.",
    repository_id: null,
    repository_name: null,
    labels: [],
    created_by: "test",
    assigned_to: "agent-review",
    agent_name: "ReviewAgent",
    agent_public_key: null,
    active_session_id: "session-review",
    result: "Implementation is ready for review.",
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
    notes: [],
  };
  const requestedActions: string[] = [];

  await page.route(`**/api/boards/${boardId}`, async (route) => {
    await route.fulfill({
      json: {
        id: boardId,
        name: "Review Board",
        description: null,
        type: "dev",
        labels: [],
        visibility: "private",
        share_slug: null,
        task_seq: 1,
        created_at: now,
        updated_at: now,
        tasks: [task],
      },
    });
  });
  await page.route(`**/api/tasks/${taskId}`, async (route) => {
    await route.fulfill({ json: task });
  });
  await page.route(`**/api/tasks/${taskId}/${action}`, async (route) => {
    expect(route.request().method()).toBe("POST");
    requestedActions.push(action);
    task = {
      ...task,
      status: action === "reject" ? "in_progress" : "done",
      updated_at: new Date().toISOString(),
    };
    await route.fulfill({ json: task });
  });
  await page.route("**/api/repositories", async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route(`**/api/tasks/${taskId}/stream?*`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: ":\n\n",
    });
  });

  await page.goto(`/boards/${boardId}`);
  const reviewColumn = page.locator('[data-column-status="in_review"]');
  await expect(reviewColumn.locator(`[data-task-id="${taskId}"]`)).toBeVisible();
  await reviewColumn.getByText(taskTitle).click();

  const dialog = page.getByRole("dialog", { name: taskTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("In Review", { exact: true })).toBeVisible();

  const dialogBox = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(dialogBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(dialogBox!.x + dialogBox!.width / 2).toBeCloseTo(viewport!.width / 2, 0);
  expect(dialogBox!.y + dialogBox!.height / 2).toBeCloseTo(viewport!.height / 2, 0);

  await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Complete", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /claim|cancel|release|assign/i })).toHaveCount(0);

  return { dialog, requestedActions };
}

test.describe("Board Page", () => {
  for (const action of ["reject", "complete"] as const) {
    test(`${action} is the only task transition available from the centered in-review dialog`, async ({ page }) => {
      const { dialog, requestedActions } = await openReviewTask(page, action);
      const actionLabel = action === "reject" ? "Reject" : "Complete";

      await dialog.getByRole("button", { name: actionLabel, exact: true }).click();

      await expect.poll(() => requestedActions).toEqual([action]);
      await expect(dialog.getByText(action === "reject" ? "In Progress" : "Done", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Complete", exact: true })).toHaveCount(0);
    });
  }
});
