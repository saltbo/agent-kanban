// spec: specs/agent-kanban.plan.md
// section: 5.7 Board item — save button hidden when no changes

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board item — save button hidden when no changes", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_nochanges_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    await page.goto(`/boards/${boardId}/settings`);

    // expect: Save is disabled initially because no changes have been made
    const saveButton = page.getByRole("button", { name: "Save" });
    await expect(saveButton).toBeDisabled();

    // 2. Change the name field, then revert it back to the original name
    const nameInput = page.getByLabel("Name");
    await nameInput.click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");

    // Save button should become enabled
    await expect(saveButton).toBeEnabled();

    // Revert: delete the 'X' we typed
    await page.keyboard.press("Backspace");

    // expect: The 'Save' button is disabled again because hasChanges returns to false
    await expect(saveButton).toBeDisabled();
  });
});
