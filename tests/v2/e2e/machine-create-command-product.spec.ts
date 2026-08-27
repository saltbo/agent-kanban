// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.2 machine-create-and-runner-command
import { expect, test } from "@playwright/test";
import { amaCollection, fulfillJson, signIn } from "./product-fixtures";

test("Add Machine creates an AMA Environment and emits the project-scoped ama-runner command", async ({ page }) => {
  await signIn(page);
  await page.route(/\/api\/v1\/environments(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST")
      return fulfillJson(route, { metadata: { uid: "env-created", projectId: "project-e2e", name: "New Build Mac" } }, 201);
    return fulfillJson(route, amaCollection([]));
  });
  for (const resource of ["runners", "sessions", "agents"])
    await page.route(new RegExp(`/api/v1/${resource}(?:\\?.*)?$`), (route) => fulfillJson(route, amaCollection([])));

  await page.goto("/machines");
  await page.getByRole("button", { name: "Add Machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Machine" });
  await dialog.getByRole("button", { name: "Your Computer" }).click();
  await dialog.getByLabel("Machine name").fill("New Build Mac");
  await dialog.getByRole("button", { name: "Add machine" }).click();

  await expect(dialog).toContainText("Authenticate through Realmroot, then start AMA Runner:");
  await expect(dialog.getByText(/ama-runner --api-server/)).toContainText('--project-id "project-e2e"');
  await expect(dialog.getByText(/ama-runner --api-server/)).toContainText('--environment-id "env-created"');
  await expect(dialog).not.toContainText(/ak start|agent-kanban start/i);
});
