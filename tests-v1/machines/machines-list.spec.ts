// spec: specs/agent-kanban.plan.md
// section: 6.2 Machines page lists machines with status indicators

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires at least one machine to be registered.
  // Since machines require a daemon to connect, this is tested conceptually here.
  // The test verifies that if machines exist, they are rendered with the correct structure.
  test.fixme("Machines page lists machines with status indicators", async ({ page }) => {
    // 1. Sign in as a user with at least one machine registered and navigate to /machines
    await signUpAndGetBoard(page, `machines_list_${Date.now()}@example.com`);
    await page.goto("/machines");

    // expect: Each machine card shows machine name, status dot, session count, active session count
    // This test requires a real machine connected, which is not possible in a unit test environment
    const machineCard = page.locator('a[href^="/machines/"]').first();
    await expect(machineCard).toBeVisible();

    // expect: Status label 'online' or 'offline' is shown
    await expect(machineCard.getByText(/online|offline/i)).toBeVisible();

    // expect: Sessions and Active labels are shown
    await expect(machineCard.getByText("Sessions:")).toBeVisible();
    await expect(machineCard.getByText("Active:")).toBeVisible();

    // expect: The count in the header reflects the number of online machines
    await expect(page.getByText(/\d+ online/)).toBeVisible();
  });
});
