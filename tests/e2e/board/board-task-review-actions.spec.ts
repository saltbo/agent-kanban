import { expect, type Page, test } from "@playwright/test";
import { seedTask, signUpAndGetBoard } from "../../helpers/auth";

const API_VERSION = "2026-08-29";
const REVIEW_ETAG = '"review-submission-v1"';

test.describe("Board Page", () => {
  test("[spec: tasks/human-review] human review actions use the canonical version-protected resources", async ({ page }) => {
    await signUpAndGetBoard(page, `reviewactions_${Date.now()}@example.com`);

    const boardId = page.url().split("/boards/")[1];
    const rejectTitle = `Reject Review ${Date.now()}`;
    const completeTitle = `Complete Review ${Date.now()}`;
    const rejectTaskId = seedTask(boardId, rejectTitle, "in_review");
    const completeTaskId = seedTask(boardId, completeTitle, "in_review");

    const canonicalCalls: Array<{ method: string; path: string; apiVersion?: string; ifMatch?: string; body: unknown }> = [];
    const legacyCommandCalls: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/api\/tasks\/[^/]+\/(?:reject|complete)$/.test(path)) legacyCommandCalls.push(`${request.method()} ${path}`);
    });
    await page.route(/\/api\/task-review-(?:submissions|rejections|completions)\/[^/?]+$/, async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      canonicalCalls.push({
        method: request.method(),
        path,
        apiVersion: request.headers()["api-version"],
        ifMatch: request.headers()["if-match"],
        body: request.postDataJSON() ?? null,
      });

      if (request.method() === "GET") {
        await route.fulfill({
          json: { taskId: path.split("/").at(-1), state: "submitted" },
          headers: { ETag: REVIEW_ETAG, "API-Version": API_VERSION },
        });
        return;
      }

      await route.fulfill({ json: { taskId: path.split("/").at(-1) }, headers: { "API-Version": API_VERSION } });
    });

    await page.reload();
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();

    await reviewTask(page, rejectTitle, "Reject");
    await reviewTask(page, completeTitle, "Complete");

    await expect
      .poll(() => canonicalCalls)
      .toEqual([
        {
          method: "GET",
          path: `/api/task-review-submissions/${rejectTaskId}`,
          apiVersion: API_VERSION,
          ifMatch: undefined,
          body: null,
        },
        {
          method: "PUT",
          path: `/api/task-review-rejections/${rejectTaskId}`,
          apiVersion: API_VERSION,
          ifMatch: undefined,
          body: { reviewSubmissionVersion: "review-submission-v1" },
        },
        {
          method: "GET",
          path: `/api/task-review-submissions/${completeTaskId}`,
          apiVersion: API_VERSION,
          ifMatch: undefined,
          body: null,
        },
        {
          method: "PUT",
          path: `/api/task-review-completions/${completeTaskId}`,
          apiVersion: API_VERSION,
          ifMatch: undefined,
          body: { reviewSubmissionVersion: "review-submission-v1" },
        },
      ]);
    expect(legacyCommandCalls).toEqual([]);
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
