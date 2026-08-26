// spec: specs/agent-kanban.plan.md
// section: 6.6 Machine list item links to machine detail page

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires at least one machine to be present in the list.
  // Since a connected machine daemon is required, this test is marked fixme.
  test.fixme("Machine list item links to machine detail page", async ({ page }) => {
    // 1. Sign in and navigate to /machines. At least one machine must be present.
    await signUpAndGetBoard(page, `machines_link_${Date.now()}@example.com`);
    await page.goto("/machines");

    // expect: Machine cards are rendered as links
    const machineLink = page.locator('a[href^="/machines/"]').first();
    await expect(machineLink).toBeVisible();

    // 2. Click on a machine card
    await machineLink.click();

    // expect: The browser navigates to /machines/:id
    await expect(page).toHaveURL(/\/machines\/.+/);

    // expect: The machine detail page is displayed with the machine's name and details
    await expect(page.getByText("Machines")).toBeVisible();
  });
});
