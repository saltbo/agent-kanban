// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.2 cloud-machine-has-no-local-runner-command
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, signIn } from "./product-fixtures";

test("a cloud AMA Environment never instructs the user to start a local runner", async ({ page }) => {
  await signIn(page);
  await page.route(`**/api/console/ama-connections/${CONNECTION_ID}/machines`, (route) => {
    if (route.request().method() === "POST")
      return fulfillJson(route, {
        metadata: { uid: "env-cloud", projectId: "project-e2e", name: "Cloud Sandbox" },
        spec: { type: "cloud" },
        status: { phase: "active" },
      });
    return fulfillJson(route, collection([]));
  });

  await page.goto("/machines?connection=ama-e2e");
  await page.getByRole("button", { name: "Add Machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Machine" });
  await dialog.getByRole("button", { name: "Cloud Sandbox" }).click();
  await dialog.getByLabel("Sandbox name").fill("Cloud Sandbox");
  await dialog.getByRole("button", { name: "Add sandbox" }).click();

  await expect(page.getByText("Cloud sandbox added")).toBeVisible();
  await expect(page.getByText(/ama-runner|--environment-id|ak start/i)).toHaveCount(0);
});
