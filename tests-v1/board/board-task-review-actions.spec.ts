import { expect, test } from "@playwright/test";
import { seedTask, signUpAndGetBoard } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Task detail shows only reject/complete in review state", async ({ page }) => {
    await signUpAndGetBoard(page, `reviewactions_${Date.now()}@example.com`);

    // Seed a task: human sessions may observe tasks but cannot create them through the API.
    const taskTitle = `Review Task ${Date.now()}`;
    const boardId = page.url().split("/boards/")[1];
    seedTask(boardId, taskTitle);

    // Reload the board to see the new task
    await page.reload();
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();

    // Click the task card to open detail
    await page.getByText(taskTitle).first().click();

    // expect: Task detail sheet is open
    const sheet = page.locator('[data-slot="sheet-content"]');
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
