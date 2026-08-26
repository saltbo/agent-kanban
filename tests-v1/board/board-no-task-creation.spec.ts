import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Board columns have no task creation UI", async ({ page }) => {
    await signUpAndGetBoard(page, `notaskcreate_${Date.now()}@example.com`);

    // expect: Board is loaded with columns
    const columnGrid = page.locator(".hidden.md\\:grid");
    await expect(columnGrid).toBeVisible();
    await expect(columnGrid.getByText("Todo")).toBeVisible();

    // expect: No "+ Task" button anywhere on the board
    await expect(page.getByRole("button", { name: "+ Task" })).not.toBeVisible();

    // expect: No task creation input field
    await expect(page.locator('input[placeholder="Task title..."]')).not.toBeVisible();
  });
});
