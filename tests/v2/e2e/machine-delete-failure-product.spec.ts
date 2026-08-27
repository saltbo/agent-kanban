// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.2 machine-delete-preserves-pending-and-errors
import { expect, test } from "@playwright/test";
import { fulfillJson, localMachine, routeAmaMachines, signIn } from "./product-fixtures";

test("Machine removal stays pending and preserves the Environment detail when AMA fails", async ({ page }) => {
  await signIn(page);
  let release!: () => void;
  const deletion = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeAmaMachines(page, [localMachine]);
  await page.route(/\/api\/v1\/environments\/env-local$/, async (route) => {
    if (route.request().method() === "DELETE") {
      await deletion;
      return fulfillJson(route, { detail: "AMA could not remove the Environment." }, 503);
    }
    return route.fallback();
  });

  await page.goto("/machines/env-local?connection=ama-e2e");
  await expect(page.getByText("Delete this AMA Environment. Realmroot identity and grants are not changed.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete Machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete AMA Environment" });
  await expect(dialog).toContainText("permanently deletes");
  await expect(dialog).toContainText("from AMA");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  const removing = dialog.getByRole("button", { name: "Deleting..." });
  await expect(removing).toBeDisabled();
  release();

  await expect(page.getByText("AMA could not remove the Environment.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator("h1").filter({ hasText: "Build Mac" })).toBeAttached();
  await expect(page).toHaveURL(/\/machines\/env-local\?connection=ama-e2e$/);
});
