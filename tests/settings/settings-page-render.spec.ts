// spec: specs/agent-kanban.plan.md
// section: 5.1 Settings profile page displays profile settings

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("redirects /settings to the profile settings page", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_redirect_${Date.now()}@example.com`);

    await page.goto("/settings");

    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  });

  test("renders only profile and account sidebar entries with profile active", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_sidebar_${Date.now()}@example.com`);

    await page.goto("/settings/profile");

    const settingsNav = page.getByRole("navigation", { name: "Settings" });
    await expect(settingsNav.getByRole("link")).toHaveText(["Profile", "Account", "Scheduling"]);
    await expect(settingsNav.getByRole("link", { name: "Profile" })).toHaveAttribute("class", /bg-accent-soft/);
    await expect(settingsNav.getByRole("link", { name: "Account" })).not.toHaveAttribute("class", /bg-accent-soft/);

    await expect(page.getByRole("heading", { name: "Theme" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "GitHub" })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Boards" })).not.toBeVisible();
  });
});
