// spec: specs/agent-kanban.plan.md
// section: 7.4 'New agent' button navigates to agent creation page

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("'New agent' button navigates to agent creation page", async ({ page }) => {
    // 1. Sign in, navigate to /agents, and click the 'New agent' button
    await signUpAndGetBoard(page, `agents_newbtn_${Date.now()}@example.com`);
    await page.goto("/agents");

    await expect(page.getByRole("link", { name: "New agent" })).toBeVisible();
    await page.getByRole("link", { name: "New agent" }).click();

    // expect: The browser navigates to /agents/new
    await expect(page).toHaveURL(/\/agents\/new/);

    // expect: The AgentNewPage is displayed with the 'New agent' heading
    await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();

    // expect: 'Recruit' and 'Custom' option cards are shown
    await expect(page.getByRole("button", { name: /Recruit/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Custom/ })).toBeVisible();
  });
});
