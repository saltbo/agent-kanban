// spec: specs/agent-kanban.plan.md
// section: 7.6 Agent creation — live preview updates as name is typed

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — live preview updates as name is typed", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click 'Custom', and look at the preview card on the right
    await signUpAndGetBoard(page, `agents_preview_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    // expect: Preview shows 'Agent' as the placeholder name
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).toBeVisible();

    // 2. Type 'Bolt' in the Name field
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Bolt");

    // expect: The preview card name updates to 'Bolt' in real time
    await expect(page.getByRole("heading", { name: "Bolt", exact: true })).toBeVisible();

    // expect: The preview no longer shows 'Agent'
    await expect(page.getByRole("heading", { name: "Agent", exact: true })).not.toBeVisible();
  });
});
