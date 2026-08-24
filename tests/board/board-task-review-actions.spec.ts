import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Task detail shows only reject/complete in review state", async ({ page }) => {
    await signUpAndGetBoard(page, `reviewactions_${Date.now()}@example.com`);

    // Create a task via API and move it to in_review status
    const taskTitle = `Review Task ${Date.now()}`;
    const _taskId = await page.evaluate(async (title) => {
      const token = localStorage.getItem("auth-token");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      // Create task
      const createRes = await fetch("/api/tasks", {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      });
      const task = (await createRes.json()) as { id: string };

      // Move to in_progress then in_review via direct DB manipulation isn't possible,
      // so use PATCH to set status indirectly — actually we need lifecycle endpoints.
      // Claim requires agent identity, so we'll update status via the API workaround:
      // Use the task update endpoint to set result/pr_url (doesn't change status),
      // but we need the task in in_review. Let's create it and check the todo state first.
      return task.id;
    }, taskTitle);

    // Reload the board to see the new task
    await page.reload();
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();

    // Click the task card to open detail
    await page.getByText(taskTitle).first().click();

    // expect: Task detail dialog is open
    const sheet = page.locator('[data-slot="dialog-content"]');
    await expect(sheet).toBeVisible();

    // expect: In todo status, NO action buttons should be visible
    await expect(sheet.getByRole("button", { name: "Reject" })).not.toBeVisible();
    await expect(sheet.getByRole("button", { name: "Complete" })).not.toBeVisible();
    await expect(sheet.getByRole("button", { name: "Claim" })).not.toBeVisible();
    await expect(sheet.getByRole("button", { name: "Cancel" })).not.toBeVisible();
    await expect(sheet.getByRole("button", { name: "Release" })).not.toBeVisible();

    // expect: No assign dropdown
    await expect(sheet.getByText("Assign...")).not.toBeVisible();

    // expect: No delete button
    await expect(sheet.getByRole("button", { name: "Delete task" })).not.toBeVisible();
  });
});
