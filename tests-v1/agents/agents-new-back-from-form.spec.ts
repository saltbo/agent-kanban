// spec: specs/agent-kanban.plan.md
// section: 7.11 Agent creation — back navigation from form step

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — back navigation from form step", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click 'Custom' to reach the form step
    await signUpAndGetBoard(page, `agents_back_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    // expect: Form step is displayed with a 'Back' button
    await expect(page.getByRole("heading", { name: "Create agent" })).toBeVisible();
    const backButton = page.getByRole("button", { name: "Back" });
    await expect(backButton).toBeVisible();

    // 2. Click the 'Back' button
    await backButton.click();

    // expect: The user returns to the 'Choose path' step showing 'Recruit' and 'Custom' cards
    await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Recruit/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Custom/ })).toBeVisible();
  });
});
