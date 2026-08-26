// spec: specs/agent-kanban.plan.md
// section: 4.5 Navigate to repositories via avatar dropdown

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Navigate to repositories via avatar dropdown", async ({ page }) => {
    // 1. Sign in, click the user avatar, and then click 'Repositories' in the dropdown
    await signUpAndGetBoard(page, `headerrepos_${Date.now()}@example.com`);

    const header = page.locator("header");
    const avatarButton = header.locator("button.rounded-full");
    await avatarButton.click();

    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();
    await dropdown.getByText("Repositories").click();

    // expect: The user is navigated to /repositories
    await expect(page).toHaveURL(/\/repositories/);

    // expect: The Repositories page is displayed
    await expect(page.getByText(/Repositories/i)).toBeVisible();
  });
});
