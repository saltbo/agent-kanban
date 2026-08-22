// spec: specs/agent-kanban.plan.md
// section: 7.13 Agent detail — click fingerprint watermark opens identity modal

import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — click fingerprint watermark opens identity modal", async ({ page }) => {
    // 1. Sign in, navigate to an agent detail page, and click the fingerprint watermark icon
    await signUpAndGetBoard(page, `agent_fp_modal_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    await page.goto(`/agents/${agentId}`);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Click the fingerprint watermark button (it shows the fingerprint short code as its label)
    const fingerprintButton = page.getByRole("button", { name: /^[0-9a-f:]+$/ }).first();
    await fingerprintButton.click();

    // expect: The 'Cryptographic Identity' modal opens
    await expect(page.getByRole("heading", { name: "Cryptographic Identity" })).toBeVisible();

    // expect: The modal displays the Fingerprint with a 'Copy' button
    await expect(page.getByText("Fingerprint")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy" }).first()).toBeVisible();

    // expect: The modal displays the Ed25519 Public Key with a 'Copy' button
    await expect(page.getByText("Ed25519 Public Key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy" }).nth(1)).toBeVisible();

    // expect: A close button is visible in the modal header
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  });
});
