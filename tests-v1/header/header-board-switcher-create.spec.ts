// spec: specs/agent-kanban.plan.md
// section: 4.8 Board switcher — create a new board

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Board switcher — create a new board", async ({ page }) => {
    // 1. Sign in, navigate to a board, open the board switcher dialog
    await signUpAndGetBoard(page, `headerboardcreate_${Date.now()}@example.com`);

    const header = page.locator("header");
    const boardNameButton = header.getByRole("button", { name: "My Board" });
    await boardNameButton.click();

    // expect: Board switcher is open
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    // 2. Click the '+ New board' button
    const newBoardButton = dialog.getByRole("button", { name: "New board" });
    await newBoardButton.click();

    // expect: An input field and 'Create' button appear in place of the 'New board' button
    const boardNameInput = dialog.locator('input[placeholder="Board name"]');
    await expect(boardNameInput).toBeVisible();
    await expect(boardNameInput).toBeFocused();

    const createButton = dialog.getByRole("button", { name: "Create" });
    await expect(createButton).toBeVisible();

    // 3. Type 'My New Board' and click 'Create'
    await boardNameInput.fill("My New Board");
    await createButton.click();

    // expect: The browser navigates to the new board's URL (board creation triggers navigation)
    await expect(page).toHaveURL(/\/boards\/.+/);

    // The dialog may stay open after navigation (Header's switcherOpen state persists).
    // Close the dialog via Escape to unblock the header.
    await page.keyboard.press("Escape");

    // expect: The header now shows the new board name
    await expect(header.getByRole("button", { name: "My New Board" })).toBeVisible();
  });
});
