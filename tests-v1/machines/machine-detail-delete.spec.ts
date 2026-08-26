// spec: specs/agent-kanban.plan.md
// section: 6.9 Machine detail — delete machine with confirmation dialog

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires a machine to be registered.
  // Since a connected machine daemon is required, this test is marked fixme.
  test.fixme("Machine detail — delete machine with confirmation dialog", async ({ page }) => {
    // 1. Sign in and navigate to a machine detail page, then click the 'Delete' button
    await signUpAndGetBoard(page, `machine_delete_${Date.now()}@example.com`);
    await page.goto("/machines");
    const machineLink = page.locator('a[href^="/machines/"]').first();
    await expect(machineLink).toBeVisible();
    await machineLink.click();
    await expect(page).toHaveURL(/\/machines\/.+/);

    await page.getByRole("button", { name: "Delete" }).click();

    // expect: A confirmation dialog opens with the title 'Delete Machine'
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Delete Machine")).toBeVisible();

    // expect: Deletion does not claim that AK owns a static API key.
    await expect(dialog.getByText(/revoke the API key/i)).toHaveCount(0);

    // expect: Cancel and 'Delete' (destructive) buttons are shown
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();

    // 2. Click 'Cancel'
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // expect: The dialog closes without deleting the machine
    await expect(dialog).not.toBeVisible();

    // 3. Click 'Delete' again, then click the red 'Delete' button in the dialog
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Delete" }).click();

    // expect: The machine is deleted
    // expect: The user is redirected to /machines
    await expect(page).toHaveURL(/\/machines$/);
  });
});
