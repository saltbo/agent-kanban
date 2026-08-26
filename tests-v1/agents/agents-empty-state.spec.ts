// spec: specs/agent-kanban.plan.md
// section: 7.1 Agents page renders empty state when no agents exist

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agents page renders empty state when no agents exist", async ({ page }) => {
    // 1. Sign in as a user with no agents and navigate to /agents
    await signUpAndGetBoard(page, `agents_empty_${Date.now()}@example.com`);
    await page.goto("/agents");

    // expect: Heading 'Agents' is displayed
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();

    // expect: A 'New agent' button is visible
    await expect(page.getByRole("link", { name: "New agent" })).toBeVisible();

    await expect(page.getByText("No latest agents yet.")).toBeVisible();
  });
});
