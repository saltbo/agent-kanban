import { expect, type Page, test } from "@playwright/test";
import { seedTask, signUpAndGetBoard } from "../../helpers/auth";

const API_VERSION = "2026-08-29";
const TASK_ETAG = '"task-version-v1"';

test.describe("Board Page", () => {
  test("[spec: tasks/human-review] human review actions directly patch the canonical Task resource", async ({ page }) => {
    await signUpAndGetBoard(page, `reviewactions_${Date.now()}@example.com`);

    const boardId = page.url().split("/boards/")[1];
    const rejectTitle = `Reject Review ${Date.now()}`;
    const completeTitle = `Complete Review ${Date.now()}`;
    const rejectTaskId = seedTask(boardId, rejectTitle, "in_review");
    const completeTaskId = seedTask(boardId, completeTitle, "in_review");

    const taskReads = new Map<string, number>();
    const taskBodies = new Map<string, Record<string, unknown>>();
    const taskPatches: Array<{
      path: string;
      apiVersion?: string;
      contentType?: string;
      ifMatch?: string;
      readsBeforePatch: number;
      body: unknown;
    }> = [];
    const obsoleteCalls: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/api\/(?:tasks\/[^/]+\/(?:reject|complete)|task-review-(?:submissions|rejections|completions)\/[^/]+)$/.test(path)) {
        obsoleteCalls.push(`${request.method()} ${path}`);
      }
    });
    await page.route(/\/api\/tasks\/[^/?]+$/, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const taskId = path.split("/").at(-1)!;

      if (request.method() === "GET") {
        taskReads.set(taskId, (taskReads.get(taskId) ?? 0) + 1);
        const response = await route.fetch();
        const task = (await response.json()) as Record<string, unknown>;
        taskBodies.set(taskId, task);
        await route.fulfill({
          status: response.status(),
          json: task,
          headers: { ETag: TASK_ETAG, "API-Version": API_VERSION },
        });
        return;
      }

      const body = request.postDataJSON() as Record<string, unknown>;
      taskPatches.push({
        path,
        apiVersion: request.headers()["api-version"],
        contentType: request.headers()["content-type"],
        ifMatch: request.headers()["if-match"],
        readsBeforePatch: taskReads.get(taskId) ?? 0,
        body,
      });
      await route.fulfill({
        json: { ...taskBodies.get(taskId), ...body },
        headers: { ETag: '"task-version-v2"', "API-Version": API_VERSION },
      });
    });

    await page.reload();
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();

    await reviewTask(page, rejectTitle, "Reject");
    await reviewTask(page, completeTitle, "Complete");

    await expect
      .poll(() => taskPatches)
      .toEqual([
        {
          path: `/api/tasks/${rejectTaskId}`,
          apiVersion: API_VERSION,
          contentType: "application/merge-patch+json",
          ifMatch: undefined,
          readsBeforePatch: 1,
          body: { status: "in-progress" },
        },
        {
          path: `/api/tasks/${completeTaskId}`,
          apiVersion: API_VERSION,
          contentType: "application/merge-patch+json",
          ifMatch: undefined,
          readsBeforePatch: 1,
          body: { status: "done" },
        },
      ]);
    expect(obsoleteCalls).toEqual([]);
  });
});

async function reviewTask(page: Page, title: string, action: "Reject" | "Complete"): Promise<void> {
  await page.getByText(title).first().click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Complete" })).toBeVisible();
  await sheet.getByRole("button", { name: action }).click();
  await sheet.getByRole("button", { name: "✕" }).click();
  await expect(sheet).not.toBeVisible();
}
