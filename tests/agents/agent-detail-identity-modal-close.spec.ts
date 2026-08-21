// spec: specs/agent-kanban.plan.md
// section: 7.14 Agent detail — close identity modal

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — close identity modal", async ({ page }) => {
    // 1. Sign in, navigate to an agent detail page, open the identity modal
    await signUpAndGetBoard(page, `agent_fp_close_${Date.now()}@example.com`);
    await page.goto("/agents");

    await page.getByText("Quality Goalkeeper").first().waitFor({ state: "visible" });
    await page.getByRole("link", { name: /Quality Goalkeeper/ }).click();
    await expect(page).toHaveURL(/\/agents\/.+/);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Open the identity modal
    const fingerprintButton = page.getByRole("button", { name: /^[0-9a-f:]+$/ }).first();
    await fingerprintButton.click();

    // expect: Identity modal is displayed.
    // Scope all modal interactions to the dialog itself (base-ui Dialog.Popup has role "dialog"
    // and is named by its title) so the bare "Close" name can't collide with other page controls.
    const dialog = page.getByRole("dialog", { name: "Cryptographic Identity" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("heading", { name: "Cryptographic Identity" })).toBeVisible();

    // 2. Click the close button in the modal header
    await dialog.getByRole("button", { name: "Close" }).click();

    // expect: The modal closes
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Cryptographic Identity" })).not.toBeVisible();

    // expect: The agent detail page is visible behind it
    await expect(page.getByRole("heading", { name: "Quality Goalkeeper" })).toBeVisible();
  });
});
