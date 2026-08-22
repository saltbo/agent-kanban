// spec: specs/agent-kanban.plan.md
// section: 2.1 Root URL offers the public handoff to Realmroot authentication

import { expect, test } from "@playwright/test";

test.describe("Routing and Navigation Guards", () => {
  test("Root URL offers the public handoff to Realmroot authentication", async ({ page, context }) => {
    // 1. Clear all cookies and local storage to ensure no session exists
    await context.clearCookies();
    await context.clearPermissions();

    // Navigate to /
    await page.goto("/");

    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("link", { name: "Sign In" }).click();
    await expect(page).toHaveURL(/\/auth/, { timeout: 5000 });
    await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
  });
});
