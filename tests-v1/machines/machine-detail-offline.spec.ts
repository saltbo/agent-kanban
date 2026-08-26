// spec: specs/agent-kanban.plan.md
// section: 6.8 Machine detail — offline machine shows reconnect instructions

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires an offline machine registered in the database.
  // Since a real machine is needed, this test is marked fixme.
  test.fixme("Machine detail — offline machine shows reconnect instructions", async ({ page }) => {
    // 1. Sign in and navigate to the detail page of an offline machine
    await signUpAndGetBoard(page, `machine_offline_${Date.now()}@example.com`);

    // Navigate to a machine detail page (requires a real machine ID)
    await page.goto("/machines");
    const machineLink = page.locator('a[href^="/machines/"]').first();
    await expect(machineLink).toBeVisible();
    await machineLink.click();
    await expect(page).toHaveURL(/\/machines\/.+/);

    // expect: A warning panel 'Machine is offline' is displayed with an amber/warning border
    await expect(page.getByText("Machine is offline")).toBeVisible();

    // expect: Reconnect uses the native Realmroot login and runtime commands.
    await expect(page.getByText(/ak auth login --api-url/)).toBeVisible();
    await expect(page.getByText(/ak start/)).toBeVisible();
  });
});
