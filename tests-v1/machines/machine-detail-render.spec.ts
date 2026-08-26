// spec: specs/agent-kanban.plan.md
// section: 6.7 Machine detail page renders machine information

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires a machine to be registered.
  // Since a connected machine daemon is required, this test is marked fixme.
  test.fixme("Machine detail page renders machine information", async ({ page }) => {
    // 1. Sign in and navigate to a machine detail page at /machines/:id
    await signUpAndGetBoard(page, `machine_detail_${Date.now()}@example.com`);
    await page.goto("/machines");

    // Navigate to the first machine detail page
    const machineLink = page.locator('a[href^="/machines/"]').first();
    await expect(machineLink).toBeVisible();
    const href = await machineLink.getAttribute("href");
    await page.goto(href!);

    // expect: A breadcrumb 'Machines / <machine-name>' is displayed
    await expect(page.getByText("Machines")).toBeVisible();
    await expect(page.locator("text=/Machines \\//i")).toBeVisible();

    // expect: Machine name is shown as a heading with a status dot and status label
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText(/online|offline/i)).toBeVisible();

    // expect: A details card shows OS, Version, Last Heartbeat, and Created date
    await expect(page.getByText("OS")).toBeVisible();
    await expect(page.getByText("Version")).toBeVisible();
    await expect(page.getByText("Last Heartbeat")).toBeVisible();
    await expect(page.getByText("Created")).toBeVisible();

    // expect: Session count and Active session count are displayed in stat cards
    await expect(page.getByText("Sessions")).toBeVisible();
    await expect(page.getByText("Active")).toBeVisible();

    // expect: A 'Delete' button is visible
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

    // expect: An 'Agents' section shows agents registered on the machine or 'No agents registered on this machine.'
    await expect(page.getByText(/Agents \(\d+\)|No agents registered on this machine\./)).toBeVisible();
  });
});
