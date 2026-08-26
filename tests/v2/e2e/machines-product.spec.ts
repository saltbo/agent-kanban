// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 4.1 machine-list-and-detail-aggregation
import { expect, test } from "@playwright/test";
import { CONNECTION_ID, collection, fulfillJson, localMachine, signIn } from "./product-fixtures";

test("Machines are AMA Environment projections with read-only Runner and Session aggregation", async ({ page }) => {
  await signIn(page);
  await page.route(new RegExp(`/api/console/ama-connections/${CONNECTION_ID}/machines(?:/[^/?]+)?(?:\\?.*)?$`), (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/machines/env-local")) return fulfillJson(route, localMachine);
    return fulfillJson(route, collection([localMachine]));
  });

  await page.goto("/machines?connection=ama-e2e");
  await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();
  const machine = page.getByRole("link", { name: /Build Mac/ });
  await expect(machine).toContainText("online");
  await expect(machine).toContainText("Sessions: 1");
  await expect(machine).toContainText("Active: 1");
  await expect(machine).toContainText("Codex");
  await expect(machine.getByTitle(/gpt-5\.6-sol/)).toBeVisible();

  await machine.click();
  await expect(page).toHaveURL(/\/machines\/env-local\?connection=ama-e2e$/);
  await expect(page.getByRole("heading", { name: "Build Mac", level: 1 })).toBeVisible();
  await expect(page.getByText("mac-mini-runner")).toBeVisible();
  await expect(page.getByText("Release Engineer")).toBeVisible();
  await expect(page.getByText("Release run")).toBeVisible();
  await expect(page.getByText(/ak start|agent-kanban start|daemon/i)).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/\/machines\/env-local\?connection=ama-e2e$/);
  await expect(page.getByRole("heading", { name: "Build Mac", level: 1 })).toBeVisible();
});
