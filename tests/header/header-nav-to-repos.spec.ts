// spec: specs/agent-kanban.plan.md
// section: 4.5 Navigate to repositories via top nav link

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Navigate to repositories via top nav link", async ({ page }) => {
    // 1. Sign in and click the 'Repositories' link in the top nav
    await signUpAndGetBoard(page, `headerrepos_${Date.now()}@example.com`);

    const header = page.locator("header");
    const reposLink = header.getByRole("link", { name: "Repositories", exact: true });
    await expect(reposLink).toBeVisible();
    await reposLink.click();

    // expect: The user is navigated to /repositories
    await expect(page).toHaveURL(/\/repositories/);

    // expect: The Repositories page is displayed
    await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  });
});
