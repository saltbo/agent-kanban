// spec: specs/agent-kanban.plan.md
// section: 2.2 Protected board URL redirects unauthenticated user to /auth

import { expect, test } from "@playwright/test";

test.describe("Routing and Navigation Guards", () => {
  test("Protected board URL redirects unauthenticated user to /auth", async ({ page, context }) => {
    // 1. With no active session, navigate to /boards/some-board-id
    await context.clearCookies();

    await page.goto("/boards/some-board-id");

    // expect: The browser is redirected to /auth
    await expect(page).toHaveURL(/\/auth/, { timeout: 5000 });

    await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Realmroot" })).toBeVisible();
  });
});
