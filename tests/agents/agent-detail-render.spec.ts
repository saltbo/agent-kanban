// spec: specs/agent-kanban.plan.md
// section: 7.12 Agent detail page renders identity hero

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail page renders identity hero", async ({ page }) => {
    // 1. Sign in and navigate to an agent's detail page at /agents/:id
    await signUpAndGetBoard(page, `agent_detail_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // expect: A '← Agents' back link is visible
    await expect(page.getByRole("link", { name: "← Agents" })).toBeVisible();

    // expect: The identity hero card shows the agent name
    await expect(page.getByRole("heading", { name: "Quality Goalkeeper" })).toBeVisible();

    // expect: Bio is visible
    await expect(page.getByText("Establishes quality standards")).toBeVisible();

    // expect: Metadata (runtime, model, created time) is visible
    await expect(page.getByText("claude", { exact: true })).toBeVisible();
    await expect(page.getByText("claude-opus-4-6")).toBeVisible();
    await expect(page.getByText(/Created/)).toBeVisible();

    // expect: A telemetry strip shows task states, input tokens, and cost stats
    await expect(page.getByText("TODO", { exact: true })).toBeVisible();
    await expect(page.getByText("PROGRESS", { exact: true })).toBeVisible();
    await expect(page.getByText("REVIEW", { exact: true })).toBeVisible();
    await expect(page.getByText("INPUT", { exact: true })).toBeVisible();
    await expect(page.getByText("COST", { exact: true })).toBeVisible();

    // expect: Tabs for 'Mission', 'Activity', and 'Sessions' are displayed below the hero card
    await expect(page.getByRole("button", { name: "Mission" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sessions" })).toBeVisible();
  });
});
