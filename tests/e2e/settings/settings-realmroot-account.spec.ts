import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../../helpers/auth";

test.describe("Realmroot account settings", () => {
  test("shows the Realmroot identity represented by the AK session", async ({ page }) => {
    const email = `settings_realmroot_${Date.now()}@example.com`;
    await signUpAndGetBoard(page, email, "Realmroot Settings User");

    await page.goto("/settings");

    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("heading", { name: "Realmroot account" })).toBeVisible();
    await expect(page.getByText("Realmroot Settings User")).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText(/^user:e2e:/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Manage in Realmroot/ })).toBeVisible();
  });

  test("delegates account management and exposes no legacy credential controls", async ({ page, context }) => {
    await signUpAndGetBoard(page, `settings_delegate_${Date.now()}@example.com`);
    await context.route("https://id.realmroot.dev/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: "<main>Realmroot console</main>" }),
    );
    await page.goto("/settings/profile");

    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /password|api key|github|session|ban/i })).toHaveCount(0);
    await expect(page.getByText(/connect github|linked account|active sessions|change password/i)).toHaveCount(0);

    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: /Manage in Realmroot/ }).click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL("https://id.realmroot.dev/");
    await expect(popup.getByText("Realmroot console")).toBeVisible();
  });
});
