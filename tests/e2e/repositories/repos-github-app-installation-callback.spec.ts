// spec: spec/repositories.feature

import { expect, test } from "@playwright/test";
import { V2_API_VERSION } from "@shared";
import { signUpAndGetBoard } from "../../helpers/auth";

test.describe("Repositories GitHub App installation callback", () => {
  test("[spec: repositories/github-import] accepts the installation and clears the callback query", async ({ page }) => {
    await signUpAndGetBoard(page, `repos_github_callback_${Date.now()}@example.com`);

    let installationRequests = 0;
    await page.route("**/api/repository-installations/123", async (route) => {
      installationRequests += 1;
      const request = route.request();

      expect(request.method()).toBe("PUT");
      expect(request.headers()["api-version"]).toBe(V2_API_VERSION);
      expect(request.headers()["content-type"]).toBe("application/json");
      expect(request.headers()["x-csrf-token"]).toBeTruthy();
      expect(request.postData()).toBeNull();

      await route.fulfill({ status: 204 });
    });

    await page.goto("/repositories?installation_id=123");

    await expect.poll(() => installationRequests).toBe(1);
    await expect(page).toHaveURL(/\/repositories$/);
    await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add Repository" })).toBeEnabled();
  });
});
