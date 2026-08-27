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
  await page.getByRole("button", { name: "E", exact: true }).click();
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
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      window.name = `${window.name}\n${key}:${value}`;
      return setItem.call(this, key, value);
    };
  });
  await page.route("**/api/configz", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        issuer: "https://realmroot.test/api/auth",
        clientId: "ak-browser",
        ak: { resource: "http://127.0.0.1:6265/api", scopes: ["boards:read"] },
        ama: { resource: "https://ama.test/api", scopes: ["agents:read", "environments:read"] },
      }),
    }),
  );
  await page.route("https://realmroot.test/api/auth/.well-known/openid-configuration", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        issuer: "https://realmroot.test/api/auth",
        authorization_endpoint: "https://realmroot.test/api/auth/oauth2/authorize",
        token_endpoint: "https://realmroot.test/api/auth/oauth2/token",
      }),
    }),
  );
  await page.goto(returnTo);

  await expect(page).toHaveURL((url) => url.pathname === "/auth" && url.searchParams.get("returnTo") === returnTo);

  await page.route("https://realmroot.test/api/auth/oauth2/authorize*", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Realmroot</title>" }),
  );
  const loginRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/oauth2/authorize");
  await page.getByRole("button", { name: "Continue to Realmroot" }).click();

  const loginUrl = new URL((await loginRequest).url());
  expect(loginUrl.searchParams.get("client_id")).toBe("ak-browser");
  expect(loginUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loginUrl.searchParams.getAll("resource")).toEqual(["http://127.0.0.1:6265/api", "https://ama.test/api"]);
  await page.waitForURL("https://realmroot.test/api/auth/oauth2/authorize*");
  expect(await page.evaluate(() => window.name)).toContain(returnTo);
  expect(loginUrl.pathname).not.toContain("/api/auth/login");
});
