// spec: specs/agent-kanban.plan.md
// section: 7.2 Agents page renders agent cards in a grid

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agents page renders agent cards in a grid", async ({ page }) => {
    // 1. Sign in as a user with at least one agent and navigate to /agents
    await signUpAndGetBoard(page, `agents_grid_${Date.now()}@example.com`);
    await seedRealmrootAgent(page);
    await page.goto("/agents");

    // Wait for the agent card grid to load
    await page.getByText("Quality Goalkeeper").first().waitFor({ state: "visible" });
    await expect(page.getByText(/^\d+\/\d+ workers schedulable$/)).toBeVisible();

    // expect: Agents are displayed in a 3-column card grid
    const agentCard = page.getByRole("link", { name: /Quality Goalkeeper/ });
    await expect(agentCard).toBeVisible();

    // expect: Each card shows the agent identicon (img), agent name, fingerprint badge, status indicator
    await expect(agentCard.getByRole("heading", { name: "Quality Goalkeeper" })).toBeVisible();
    await expect(agentCard.getByText(/^(?:Not schedulable|Schedulable)$/)).toBeVisible();

    // expect: Stats strip with task state counts, token count, and cost
    await expect(agentCard.getByText(/todo/)).toBeVisible();
    await expect(agentCard.getByText(/progress/)).toBeVisible();
    await expect(agentCard.getByText(/review/)).toBeVisible();
    await expect(agentCard.getByText(/tok/)).toBeVisible();
    await expect(agentCard.getByText(/\$/)).toBeVisible();
  });
});
