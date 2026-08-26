// spec: specs/agent-kanban.plan.md
// section: 6.10 Machine detail — agent list links to agent detail page

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  // This test requires a machine with at least one agent listed.
  // Since a running agent daemon is required, this test is marked fixme.
  test.fixme("Machine detail — agent list links to agent detail page", async ({ page }) => {
    // 1. Sign in and navigate to a machine detail page that has at least one agent listed
    await signUpAndGetBoard(page, `machine_agentlink_${Date.now()}@example.com`);
    await page.goto("/machines");
    const machineLink = page.locator('a[href^="/machines/"]').first();
    await expect(machineLink).toBeVisible();
    await machineLink.click();
    await expect(page).toHaveURL(/\/machines\/.+/);

    // expect: Agent cards show agent name, status dot, and last active time
    const agentCard = page.locator('a[href^="/agents/"]').first();
    await expect(agentCard).toBeVisible();

    // 2. Click on an agent card in the machine detail view
    await agentCard.click();

    // expect: The browser navigates to /agents/:agentId
    await expect(page).toHaveURL(/\/agents\/.+/);

    // expect: The agent detail page is displayed
    await expect(page.getByText("← Agents")).toBeVisible();
  });
});
