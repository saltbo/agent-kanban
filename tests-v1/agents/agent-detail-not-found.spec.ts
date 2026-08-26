// spec: specs/agent-kanban.plan.md
// section: 7.18 Agent not found shows graceful error state

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent not found shows graceful error state", async ({ page }) => {
    // 1. Sign in and navigate to /agents/nonexistent-id
    await signUpAndGetBoard(page, `agent_notfound_${Date.now()}@example.com`);
    await page.goto("/agents/nonexistent-id");

    // expect: The page shows 'Agent not found.' text in the content area
    await page.getByText("Agent not found.").first().waitFor({ state: "visible" });
    await expect(page.getByText("Agent not found.")).toBeVisible();

    // expect: The header is still rendered correctly
    await expect(page.getByRole("link", { name: /Agent Kanban/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Agents" })).toBeVisible();
  });
});
