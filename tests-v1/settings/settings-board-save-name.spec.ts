// spec: specs/agent-kanban.plan.md
// section: 5.6 Board item — save updated name

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board item — save updated name", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_savename_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    await page.goto(`/boards/${boardId}/settings`);

    // expect: The board Name input shows the current board name
    const nameInput = page.getByLabel("Name");
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue("My Board");

    // 2. Clear the Name input and type 'Renamed Board'
    // expect: A 'Save' button appears because changes are detected
    await nameInput.fill("Renamed Board");
    await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(nameInput).toHaveValue("Renamed Board");

    // 3. Click 'Save'
    await page.getByRole("button", { name: "Save" }).click();

    // expect: The board name updates to 'Renamed Board'
    await expect(page.getByRole("main").getByText("Renamed Board")).toBeVisible();

    // expect: The 'Save' button is disabled after saving (no pending changes)
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
