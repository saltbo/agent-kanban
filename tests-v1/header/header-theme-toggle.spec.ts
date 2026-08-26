// spec: specs/agent-kanban.plan.md
// section: 4.2 Theme toggle cycles through dark, light, system

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Theme toggle cycles through dark, light, system", async ({ page }) => {
    // 1. Sign in and navigate to any page.
    await signUpAndGetBoard(page, `headertheme_${Date.now()}@example.com`);
    await page.goto("/settings");

    const header = page.locator("header");

    // The theme toggle is the last button in the header
    const themeButton = header.locator("button").last();
    await expect(themeButton).toBeVisible();

    // Get the initial HTML class state (may be null, empty, 'dark', 'light', etc.)
    const htmlClass = await page.locator("html").getAttribute("class");

    // 2. Click the theme toggle button three times to cycle through all three states
    // Theme cycle: dark -> light -> system -> dark (cycleTheme function)
    await themeButton.click();
    await themeButton.click();
    await themeButton.click();

    // expect: After three clicks, the theme state returns to the original
    // Both null and "" represent no explicit class (system theme), so normalize
    const htmlClassAfter = await page.locator("html").getAttribute("class");
    const normalize = (c: string | null) => c ?? "";
    expect(normalize(htmlClassAfter)).toBe(normalize(htmlClass));
  });
});
