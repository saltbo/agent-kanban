// spec: specs/agent-kanban.plan.md
// section: 7.3 Agent card links to agent detail page

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent card links to agent detail page", async ({ page }) => {
    // 1. Sign in, navigate to /agents, and click on an agent card
    await signUpAndGetBoard(page, `agents_card_${Date.now()}@example.com`);
    await seedRealmrootAgent(page);
    await page.goto("/agents");

    await page.getByText("Quality Goalkeeper").first().waitFor({ state: "visible" });

    // Click the agent card
    await page.getByRole("link", { name: /Quality Goalkeeper/ }).click();

    // expect: The browser navigates to /agents/:id
    await expect(page).toHaveURL(/\/agents\/.+/);

    // expect: The agent detail page is displayed
    await page.getByText("← Agents").first().waitFor({ state: "visible" });
    await expect(page.getByRole("heading", { name: "Quality Goalkeeper" })).toBeVisible();
  });
});
