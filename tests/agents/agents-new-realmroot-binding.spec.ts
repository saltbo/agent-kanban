import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agent Realmroot binding", () => {
  test("requires and submits the Realmroot Agent ID with the AMA Vault credential reference", async ({ page }) => {
    await signUpAndGetBoard(page, `agent_realmroot_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Realmroot Worker");
    await page.getByRole("textbox", { name: "Username" }).fill("realmroot-worker");
    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page.getByText("Realmroot Agent ID and AMA Vault credential reference are required.")).toBeVisible();

    const realmrootAgentId = "agent_e2e_realmroot_worker";
    const credentialRef = "ama://vaults/vault-e2e/credentials/credential-e2e";
    await page.getByRole("textbox", { name: "Realmroot Agent ID" }).fill(realmrootAgentId);
    await page.getByRole("textbox", { name: "Realmroot credential reference" }).fill(credentialRef);

    let submittedBody: Record<string, unknown> | null = null;
    await page.route("**/api/agents", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      submittedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "agent-e2e", ...submittedBody }),
      });
    });

    await page.getByRole("button", { name: "Create agent" }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect
      .poll(() => submittedBody)
      .toMatchObject({
        realmroot_agent_id: realmrootAgentId,
        realmroot_credential_ref: credentialRef,
      });
  });
});
