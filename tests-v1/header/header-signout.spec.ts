// spec: specs/agent-kanban.plan.md
// section: 4.6 Sign out via avatar dropdown

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Sign out sends CSRF and follows the Realmroot end-session redirect", async ({ page }) => {
    // 1. Sign in and navigate to any page
    await signUpAndGetBoard(page, `headersignout_${Date.now()}@example.com`);

    const realmrootLogoutUrl =
      "https://logout.realmroot.test/end-session?client_id=ak-web-e2e&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A6265%2F";
    let logoutCsrf: string | null = null;
    await page.route("**/api/auth/logout", async (route) => {
      logoutCsrf = route.request().headers()["x-csrf-token"] ?? null;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ logoutUrl: realmrootLogoutUrl }),
      });
    });
    await page.route("https://logout.realmroot.test/**", (route) => {
      route.fulfill({ status: 200, contentType: "text/html", body: "<main>Realmroot signed out</main>" });
    });

    const header = page.locator("header");

    // Click the avatar button
    const avatarButton = header.locator("button.rounded-full");
    await avatarButton.click();

    const dropdown = page.locator('[data-slot="dropdown-menu-content"]');
    await expect(dropdown).toBeVisible();

    // Click 'Sign out'
    await dropdown.getByText("Sign out").click();

    await expect(page).toHaveURL(realmrootLogoutUrl);
    await expect(page.getByText("Realmroot signed out")).toBeVisible();
    expect(logoutCsrf).toBeTruthy();
  });
});
