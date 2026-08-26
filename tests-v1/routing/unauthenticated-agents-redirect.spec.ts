// spec: specs/agent-kanban.plan.md
// section: 2.4 Protected agents URL redirects unauthenticated user to /auth

import { expect, test } from "@playwright/test";

test.describe("Routing and Navigation Guards", () => {
  test("Protected agents URL redirects unauthenticated user to /auth", async ({ page, context }) => {
    // 1. With no active session, navigate to /agents
    await context.clearCookies();

    await page.goto("/agents");

    // expect: The browser is redirected to /auth
    await expect(page).toHaveURL(/\/auth/, { timeout: 5000 });

    await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
  });
});
