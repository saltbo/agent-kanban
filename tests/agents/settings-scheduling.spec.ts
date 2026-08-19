// E2E: scheduling settings — default peak windows render, edits round-trip
// through D1, and the spec restores defaults so it is idempotent against the
// shared dev database. Settings are per-owner (owner_settings table), so a
// fresh sign-up always starts from DEFAULT_SCHEDULING_SETTINGS.

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Scheduling settings", () => {
  test("renders default peak windows and persists edits", async ({ page }) => {
    // 1. Sign in and navigate to /settings/scheduling
    await signUpAndGetBoard(page, `settings_scheduling_${Date.now()}@example.com`);
    await page.goto("/settings/scheduling");

    await expect(page.getByRole("heading", { name: "Scheduling", level: 1 })).toBeVisible();

    // expect: the settings nav exposes a 'Scheduling' entry
    const settingsNav = page.getByRole("navigation", { name: "Settings" });
    await expect(settingsNav.getByRole("link", { name: "Scheduling" })).toBeVisible();

    // 2. Verify the default peak windows render: 09:00–12:00 and 14:00–18:00,
    //    timezone Asia/Shanghai
    await expect(page.getByLabel("Window 1 start")).toHaveValue("09:00");
    await expect(page.getByLabel("Window 1 end")).toHaveValue("12:00");
    await expect(page.getByLabel("Window 2 start")).toHaveValue("14:00");
    await expect(page.getByLabel("Window 2 end")).toHaveValue("18:00");
    await expect(page.locator("#scheduling-timezone")).toHaveValue("Asia/Shanghai");
    await expect(page.getByLabel("Window 3 start")).toHaveCount(0);

    // 3. Change window 1 start to 08:30 and save
    await page.getByLabel("Window 1 start").fill("08:30");
    await page.getByRole("button", { name: "Save scheduling" }).click();

    // expect: success toast and the form is no longer dirty
    await expect(page.getByText("Scheduling settings saved")).toBeVisible();
    await expect(page.getByText("No unsaved changes")).toBeVisible();

    // 4. Reload the page and verify 08:30 persisted (GET /api/settings/scheduling
    //    round-trips through D1)
    await page.reload();
    await expect(page.getByLabel("Window 1 start")).toHaveValue("08:30");
    await expect(page.getByLabel("Window 1 end")).toHaveValue("12:00");

    // 5. Cleanup: restore the default 09:00 start and save so the spec is
    //    idempotent against the shared dev database
    await page.getByLabel("Window 1 start").fill("09:00");
    await page.getByRole("button", { name: "Save scheduling" }).click();
    await expect(page.getByText("Scheduling settings saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Window 1 start")).toHaveValue("09:00");
  });
});
