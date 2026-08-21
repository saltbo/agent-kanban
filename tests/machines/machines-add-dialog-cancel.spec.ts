// spec: specs/agent-kanban.plan.md
// section: 6.5 Closing Realmroot machine setup keeps no browser credential

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  test("Closing Realmroot machine setup keeps no browser credential", async ({ page }) => {
    await signUpAndGetBoard(page, `machines_cancel_${Date.now()}@example.com`);
    await page.goto("/machines");
    await expect(page.getByText("No machines registered.")).toBeVisible();

    await page.getByRole("button", { name: "Add Machine" }).first().click();

    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toBeVisible();

    await dialog.getByRole("button", { name: /Your Computer/ }).click();

    await expect(dialog.getByText(/Authenticate this machine through Realmroot/)).toBeVisible();
    await expect(dialog.getByText(/agent-kanban auth login --api-url/)).toBeVisible();
    await expect(dialog.getByText(/--api-key/)).toHaveCount(0);

    // 2. Close the dialog by pressing Escape before the machine connects
    await page.keyboard.press("Escape");

    // expect: The dialog closes
    await expect(dialog).not.toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("auth-token"))).toBeNull();

    // expect: The machines list does not show a new machine
    await expect(page.getByText("No machines registered.")).toBeVisible();
  });
});
