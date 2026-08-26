// spec: specs/agent-kanban.plan.md
// section: 7.15 Agent detail — Mission tab shows active task or 'No active mission'

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — Mission tab shows 'No active mission'", async ({ page }) => {
    // 1. Sign in and navigate to an agent that has no active task assigned
    await signUpAndGetBoard(page, `agent_mission_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Mission tab is active by default
    await expect(page.getByRole("button", { name: "Mission" })).toBeVisible();

    // expect: The Mission tab content shows 'No active mission.'
    await expect(page.getByText("No active mission.")).toBeVisible();
  });
});
