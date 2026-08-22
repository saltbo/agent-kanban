import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agent identity enrollment", () => {
  test("does not ask the user for Realmroot Agent or credential identifiers", async ({ page }) => {
    await signUpAndGetBoard(page, `agent_realmroot_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    await expect(page.getByRole("textbox", { name: "Realmroot Agent ID" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Realmroot credential reference" })).toHaveCount(0);
    await expect(page.getByText(/AMA Vault credential reference/i)).toHaveCount(0);

    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Realmroot Worker");
    await page.getByRole("textbox", { name: "Username" }).fill("realmroot-worker");

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
    await expect.poll(() => submittedBody).toMatchObject({ name: "Realmroot Worker", username: "realmroot-worker", runtime: "claude" });
    expect(submittedBody).not.toHaveProperty("realmroot_agent_id");
    expect(submittedBody).not.toHaveProperty("realmroot_credential_ref");
  });
});
