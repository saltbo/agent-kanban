// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 3.2 ama-agent-create-success-and-failure
import { expect, test } from "@playwright/test";
import { amaCollection, fulfillJson, readyAgent, signIn } from "./product-fixtures";

test("Agent creation consumes the synchronous AMA Agent representation and preserves failures", async ({ page }) => {
  await signIn(page);
  let createCount = 0;
  let succeeded = false;
  await page.route(/\/api\/v1\/agents(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      createCount += 1;
      if (createCount === 1) {
        succeeded = true;
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          headers: { Location: "/api/v1/agents/agent-ready" },
          body: JSON.stringify(readyAgent),
        });
      }
      return fulfillJson(route, { detail: "Realmroot identity enrollment failed." }, 422);
    }
    return fulfillJson(route, amaCollection(succeeded ? [readyAgent] : []));
  });
  await page.route(/\/api\/v1\/sessions(?:\?.*)?$/, (route) => fulfillJson(route, amaCollection([])));

  await page.goto("/agents?connection=ama-e2e");
  await page.getByRole("link", { name: "New agent" }).click();
  await expect(page).toHaveURL(/\/agents\/new\?connection=ama-e2e$/);
  await page.getByLabel("Name", { exact: true }).fill("Release Engineer");
  await page.getByLabel("Username").fill("release-engineer");
  await page.getByLabel("System prompt").fill("Verify the release.");
  await expect(page.getByLabel(/issuer|subject|private key|credential/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Create Agent" }).click();
  await expect(page).toHaveURL(/\/agents\?connection=ama-e2e$/, { timeout: 4_000 });
  await expect(page.getByRole("link", { name: /Release Engineer/ })).toContainText("Ready");

  await page.getByRole("link", { name: "New agent" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Broken Agent");
  await page.getByLabel("Username").fill("broken-agent");
  await page.getByLabel("System prompt").fill("This enrollment will fail.");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await expect(page.getByRole("alert")).toHaveText("Realmroot identity enrollment failed.", { timeout: 4_000 });
  await expect(page).toHaveURL(/\/agents\/new\?connection=ama-e2e$/);
  expect(createCount).toBe(2);
});
