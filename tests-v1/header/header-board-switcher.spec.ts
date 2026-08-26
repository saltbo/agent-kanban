// spec: specs/agent-kanban.plan.md
// section: 4.7 Board name in header opens board switcher

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Board name in header opens board switcher", async ({ page }) => {
    // 1. Sign in and navigate to a board page. The header should show 'Agent Kanban / <board name>'.
    await signUpAndGetBoard(page, `headerboardsw_${Date.now()}@example.com`);

    const header = page.locator("header");

    // expect: The board name is displayed next to the logo as a ghost button
    const boardNameButton = header.getByRole("button", { name: "My Board" });
    await expect(boardNameButton).toBeVisible();

    // 2. Click the board name button
    await boardNameButton.click();

    // expect: A 'Switch Board' dialog opens listing all available boards
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Switch Board")).toBeVisible();

    // expect: The active board is highlighted with an accent color and a dot indicator
    const activeBoardBtn = dialog.locator(".bg-accent-soft");
    await expect(activeBoardBtn).toBeVisible();

    // expect: A 'New board' option is present at the bottom of the dialog
    await expect(dialog.getByRole("button", { name: "New board" })).toBeVisible();
  });
});
