// spec: specs/agent-kanban.plan.md
// section: 7.10 Agent creation — choose 'Recruit' path shows template grid

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — choose 'Recruit' path shows template grid", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click the 'Recruit' card
    await signUpAndGetBoard(page, `agents_recruit_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Recruit Choose from battle-" }).click();

    // expect: The 'Recruit an agent' step is shown with the heading and subtitle
    await expect(page.getByRole("heading", { name: "Recruit an agent" })).toBeVisible();
    await expect(page.getByText("Select a role template to get started")).toBeVisible();

    // expect: A grid of agent template cards is loaded
    // Wait for at least one template card to appear (fetched from remote)
    await page.getByRole("button", { name: /backend-developer/i }).waitFor({ state: "visible" });

    // expect: Each template card shows an identicon, name, and slug badge
    const backendCard = page.getByRole("button", { name: /Backend Developer/ });
    await expect(backendCard).toBeVisible();
    await expect(backendCard.getByText("backend-developer")).toBeVisible();
  });
});
