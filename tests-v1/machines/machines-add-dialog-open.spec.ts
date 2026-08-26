// spec: specs/agent-kanban.plan.md
// section: 6.3 Open Add Machine dialog

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  test("Open Add Machine dialog", async ({ page }) => {
    // 1. Sign in and navigate to /machines, then click 'Add Machine'
    await signUpAndGetBoard(page, `machines_dialog_${Date.now()}@example.com`);
    await page.goto("/machines");
    await expect(page.getByText("No machines registered.")).toBeVisible();

    await page.getByRole("button", { name: "Add Machine" }).first().click();

    const dialog = page.locator('[data-slot="dialog-content"]');

    // expect: A dialog opens with the title 'Add Machine'
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Add Machine")).toBeVisible();

    // expect: Two options are presented: 'Your Computer' and 'Cloud Sandbox', both enabled.
    await expect(dialog.getByRole("button", { name: /Your Computer/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Your Computer/ })).toBeEnabled();

    await expect(dialog.getByRole("button", { name: /Cloud Sandbox/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Cloud Sandbox/ })).toBeEnabled();
  });
});
