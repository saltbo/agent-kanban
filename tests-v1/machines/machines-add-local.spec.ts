// spec: specs/agent-kanban.plan.md
// section: 6.4 Add Machine dialog — choose 'Your Computer' shows setup steps

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  test("Add Machine dialog — choose 'Your Computer' shows setup steps", async ({ page }) => {
    // 1. Sign in, navigate to /machines, click 'Add Machine', then click 'Your Computer'
    await signUpAndGetBoard(page, `machines_local_${Date.now()}@example.com`);
    await page.goto("/machines");
    await expect(page.getByText("No machines registered.")).toBeVisible();

    await page.getByRole("button", { name: "Add Machine" }).first().click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    // Click 'Your Computer'
    await dialog.getByRole("button", { name: /Your Computer/ }).click();

    // expect: Setup uses Realmroot Device Flow and contains no static API key.
    await expect(dialog.getByText(/Authenticate this machine through Realmroot/)).toBeVisible();
    await expect(dialog.getByText(/npx agent-kanban auth login --api-url/)).toBeVisible();
    await expect(dialog.getByText(/npx agent-kanban start/)).toBeVisible();
    await expect(dialog.getByText(/--api-key/)).toHaveCount(0);

    // Close dialog after test
    await page.keyboard.press("Escape");
  });
});
