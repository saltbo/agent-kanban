// spec: avatar dropdown no longer contains Repositories (moved to top nav); Settings and Sign out remain

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Avatar dropdown no longer contains Repositories", async ({ page }) => {
    // 1. Sign up, land on a board page, and open the avatar dropdown
    await signUpAndGetBoard(page, `headeravatarnorepos_${Date.now()}@example.com`);

    const header = page.locator("header");
    await header.locator("button.rounded-full").click();

    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();

    // expect: The dropdown does not contain a Repositories item
    await expect(dropdown.getByText("Repositories")).toHaveCount(0);

    // expect: Settings and Sign out are still present
    await expect(dropdown.getByText("Settings")).toBeVisible();
    await expect(dropdown.getByText("Sign out")).toBeVisible();
  });
});
