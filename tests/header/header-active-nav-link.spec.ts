// spec: specs/agent-kanban.plan.md
// section: 4.10 Agents nav link is highlighted when on agents page

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Agents nav link is highlighted when on agents page", async ({ page }) => {
    // 1. Sign in and navigate to /agents
    await signUpAndGetBoard(page, `headernavlink_${Date.now()}@example.com`);
    await page.goto("/agents");

    const header = page.locator("header");

    // expect: The 'Agents' nav link in the header is highlighted with accent color and accent-soft background
    const agentsLink = header.getByRole("link", { name: "Agents" });
    await expect(agentsLink).toBeVisible();
    await expect(agentsLink).toHaveClass(/text-accent/);
    await expect(agentsLink).toHaveClass(/bg-accent-soft/);

    // expect: The other primary nav links are present but not highlighted
    for (const name of ["Machines", "Repositories", "Skills"]) {
      const link = header.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link).not.toHaveClass(/text-accent/);
    }
  });
});
