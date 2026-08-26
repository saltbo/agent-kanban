// spec: specs/agent-kanban.plan.md
// section: 3.13 Board shows loading skeleton while data is fetching

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Board shows loading skeleton while data is fetching", async ({ page }) => {
    // Sign in first to get a valid session and board ID
    await signUpAndGetBoard(page, `boardloading_${Date.now()}@example.com`);

    // Get the current board URL
    const boardUrl = page.url();

    // 1. Navigate to a board URL with network throttled to simulate slow loading
    await page.route("**/api/boards/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto(boardUrl);

    // expect: Pulse-animated skeleton placeholders are shown before real data arrives
    const skeletons = page.locator(".animate-pulse");
    await expect(skeletons.first()).toBeVisible();

    // expect: Once data loads, the skeleton is replaced by actual content
    await expect(skeletons.first()).not.toBeVisible({ timeout: 10000 });

    // expect: The board columns appear after data loads
    const columnGrid = page.locator(".hidden.md\\:grid");
    await expect(columnGrid).toBeVisible();
    await expect(columnGrid.getByText("Todo")).toBeVisible();
  });
});
