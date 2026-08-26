// spec: specs/agent-kanban.plan.md
// section: 7.7 Agent creation — 'Create agent' button disabled when name is empty

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — 'Create agent' button disabled when name is empty", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click 'Custom'
    await signUpAndGetBoard(page, `agents_disabled_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    // expect: The 'Create agent' button is visible
    const createButton = page.getByRole("button", { name: "Create agent" });
    await expect(createButton).toBeVisible();

    // 2. Leave the Name field empty
    // expect: The 'Create agent' button is disabled (cannot be clicked to submit)
    await expect(createButton).toBeDisabled();

    // 3. Type any name in the Name field
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("TestAgent");

    // expect: The 'Create agent' button becomes enabled
    await expect(createButton).toBeEnabled();
  });
});
