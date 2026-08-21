import { expect, test } from "@playwright/test";

test.describe("Realmroot authentication", () => {
  test("offers Realmroot as the only sign-in method", async ({ page }) => {
    await page.goto("/auth");

    await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
    await expect(page.getByText("Realmroot owns your identity, organization, sessions, and security settings.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to Realmroot" })).toBeVisible();

    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByText(/sign up|create account/i)).toHaveCount(0);
    await expect(page.getByText(/github/i)).toHaveCount(0);
  });

  test("hands browser login to the server-side Realmroot flow", async ({ page }) => {
    let loginRequests = 0;
    await page.route("**/api/auth/login", async (route) => {
      loginRequests += 1;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<main>Realmroot authorization boundary</main>" });
    });

    await page.goto("/auth");
    await page.getByRole("button", { name: "Continue to Realmroot" }).click();

    await expect(page).toHaveURL(/\/api\/auth\/login$/);
    await expect(page.getByText("Realmroot authorization boundary")).toBeVisible();
    expect(loginRequests).toBe(1);
  });

  test("requests AK and AMA resources and their browser scopes in one authorization", async ({ request }) => {
    const metadataResponse = await request.get("/.well-known/oauth-protected-resource/api");
    expect(metadataResponse.ok()).toBe(true);
    const metadata = (await metadataResponse.json()) as { resource: string };

    const login = await request.get("/api/auth/login", { maxRedirects: 0 });
    expect(login.status()).toBe(302);
    const authorizationUrl = new URL(login.headers().location);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://id.realmroot.dev/api/auth/oauth2/authorize");
    expect(authorizationUrl.searchParams.getAll("resource")).toEqual([metadata.resource, "https://ama.tftt.cc/api"]);

    const scopes = new Set(authorizationUrl.searchParams.get("scope")?.split(" "));
    for (const scope of [
      "openid",
      "profile",
      "email",
      "offline_access",
      "ak:read",
      "ak:write",
      "agents:read",
      "agents:write",
      "projects:read",
      "projects:write",
      "sessions:read",
      "sessions:write",
      "vaults:read",
      "vaults:write",
    ]) {
      expect(scopes).toContain(scope);
    }
  });

  test("renders callback failures returned by the server", async ({ page }) => {
    await page.goto("/auth?error=Expired%20or%20replayed%20Realmroot%20callback");

    await expect(page.getByRole("alert")).toHaveText("Expired or replayed Realmroot callback");
    await expect(page.getByRole("button", { name: "Continue to Realmroot" })).toBeVisible();
  });
});
