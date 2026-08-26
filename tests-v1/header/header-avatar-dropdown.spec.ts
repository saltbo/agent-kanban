// spec: specs/agent-kanban.plan.md
// section: 4.3 User avatar dropdown menu opens

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("User avatar dropdown menu opens", async ({ page }) => {
    const userName = "Avatar Dropdown Tester";
    // 1. Sign in and navigate to any page. Click the user avatar button in the header.
    await signUpAndGetBoard(page, `headeravatar_${Date.now()}@example.com`, userName);
    await page.goto("/settings");

    const header = page.locator("header");

    // Click the avatar button (the rounded button with Avatar inside)
    const avatarButton = header.locator("button.rounded-full");
    await avatarButton.click();

    // expect: A dropdown menu appears showing the user's name or email
    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();
    await expect(dropdown.getByText(userName)).toBeVisible();

    // expect: Menu items include 'Settings', 'Repositories', and 'Sign out'
    await expect(dropdown.getByText("Settings")).toBeVisible();
    await expect(dropdown.getByText("Repositories")).toBeVisible();
    await expect(dropdown.getByText("Sign out")).toBeVisible();
  });
});
