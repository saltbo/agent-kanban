// spec: specs/agent-kanban.plan.md
// section: 7.16 Agent detail — Activity tab lists logs or empty state

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — Activity tab lists logs or empty state", async ({ page }) => {
    // 1. Sign in, navigate to an agent detail page, and click the 'Activity' tab
    await signUpAndGetBoard(page, `agent_activity_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Click the Activity tab
    await page.getByRole("button", { name: "Activity" }).click();

    // expect: If no logs exist, the text 'No activity yet.' is displayed
    // (For a fresh agent, there are no logs)
    await expect(page.getByText("No activity yet.")).toBeVisible();
  });
});
