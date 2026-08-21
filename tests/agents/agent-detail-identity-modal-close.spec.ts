// spec: specs/agent-kanban.plan.md
// section: 7.14 Agent detail — close identity modal

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — close identity modal", async ({ page }) => {
    // 1. Sign in, navigate to an agent detail page, open the identity modal
    await signUpAndGetBoard(page, `agent_fp_close_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Open the identity modal
    const fingerprintButton = page.getByRole("button", { name: /^[0-9a-f:]+$/ }).first();
    await fingerprintButton.click();

    // expect: Identity modal is displayed
    await expect(page.getByRole("heading", { name: "Cryptographic Identity" })).toBeVisible();

    // 2. Click the close button in the modal header
    await page.getByRole("button", { name: "Close" }).click();

    // expect: The modal closes
    await expect(page.getByRole("heading", { name: "Cryptographic Identity" })).not.toBeVisible();

    // expect: The agent detail page is visible behind it
    await expect(page.getByRole("heading", { name: "Quality Goalkeeper" })).toBeVisible();
  });
});
