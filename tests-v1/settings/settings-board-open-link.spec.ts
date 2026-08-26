// spec: specs/agent-kanban.plan.md
// section: 5.9 Board settings links navigate to board settings routes

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board header links navigate to settings and labels", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_openlink_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];

    await page.getByRole("link", { name: "Board settings" }).click();

    await expect(page).toHaveURL(`/boards/${boardId}/settings`);
    await expect(page.getByRole("heading", { name: "Board settings" })).toBeVisible();

    await page.goto(`/boards/${boardId}`);
    await page.getByRole("link", { name: "Labels" }).click();

    await expect(page).toHaveURL(`/boards/${boardId}/labels`);
    await expect(page.getByRole("heading", { name: "Labels", level: 1 })).toBeVisible();
  });
});
