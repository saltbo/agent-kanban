// spec: specs/agent-kanban.plan.md
// section: 7.17 Agent detail — Sessions tab lists sessions or empty state

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — Sessions tab lists sessions or empty state", async ({ page }) => {
    // 1. Sign in, navigate to an agent detail page, and click the 'Sessions' tab
    await signUpAndGetBoard(page, `agent_sessions_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Click the Sessions tab
    await page.getByRole("button", { name: "Sessions" }).click();

    // expect: If no sessions exist, the text 'No sessions yet.' is displayed
    await expect(page.getByText("No sessions yet.")).toBeVisible();
  });
});
