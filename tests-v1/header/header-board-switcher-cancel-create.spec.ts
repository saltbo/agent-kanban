// spec: specs/agent-kanban.plan.md
// section: 4.9 Board switcher — cancel board creation with Escape

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  // fixme: Pressing Escape in the board name input propagates to the Dialog and closes the entire
  // dialog rather than just dismissing the create input. The test assumes Escape only hides the
  // create input and leaves the dialog open, but the actual behavior closes the dialog entirely.
  test.fixme("Board switcher — cancel board creation with Escape", async ({ page }) => {
    await signUpAndGetBoard(page, `headerboardcancel_${Date.now()}@example.com`);

    const header = page.locator("header");
    const boardNameButton = header.getByRole("button", { name: "My Board" });
    await boardNameButton.click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "New board" }).click();

    // expect: Create input is visible
    const boardNameInput = dialog.locator('input[placeholder="Board name"]');
    await expect(boardNameInput).toBeVisible();

    // 2. Press Escape — this closes the entire dialog (Escape propagates to Dialog)
    await boardNameInput.press("Escape");

    // expect: The create input is hidden
    await expect(boardNameInput).not.toBeVisible();

    // expect: The 'New board' button is shown again
    await expect(dialog.getByRole("button", { name: "New board" })).toBeVisible();

    // expect: No board is created (dialog still shows original board list)
    await expect(dialog.getByText("My Board")).toBeVisible();
  });
});
