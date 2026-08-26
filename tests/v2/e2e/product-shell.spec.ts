// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 1.1 protected-product-routes
import { expect, test } from "@playwright/test";
import { signIn } from "./product-fixtures";

test("protected product routes retain the complete route-aware v1 shell", async ({ page }) => {
  await signIn(page);
  await page.goto("/boards/board-main");

  const navigation = page.getByRole("navigation");
  await expect(page.getByRole("link", { name: /Agent Kanban/i })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
  await expect(navigation.getByRole("link", { name: "Machines" })).toHaveAttribute("href", "/machines");
  await page.getByRole("button", { name: "T", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Repositories" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "V2 Delivery" })).toBeVisible();

  await navigation.getByRole("link", { name: "Agents" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/boards\/board-main$/);
});

test("Realmroot sign-in preserves the complete protected deep link", async ({ page }) => {
  const returnTo = "/machines/env-1?connection=conn-1";
  await page.goto(returnTo);

  await expect(page).toHaveURL((url) => url.pathname === "/auth" && url.searchParams.get("returnTo") === returnTo);

  await page.route("**/api/auth/login*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Realmroot login</title>" }),
  );
  const loginRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/login");
  await page.getByRole("button", { name: "Continue to Realmroot" }).click();

  const loginUrl = new URL((await loginRequest).url());
  expect(loginUrl.searchParams.get("return_to")).toBe(returnTo);
});
