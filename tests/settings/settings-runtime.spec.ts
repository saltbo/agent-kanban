import { expect, type Page, type Route, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

type RuntimeSettings = {
  skill_cache_auto_update: boolean;
  skill_cache_refresh_hours: number;
};

const defaults: RuntimeSettings = {
  skill_cache_auto_update: true,
  skill_cache_refresh_hours: 24,
};

async function mockRuntimeSettings(page: Page, initial = defaults) {
  let saved = { ...initial };
  let lastPut: RuntimeSettings | undefined;

  await page.route("**/api/settings/runtime", async (route) => {
    if (route.request().method() === "PUT") {
      lastPut = route.request().postDataJSON() as RuntimeSettings;
      saved = { ...lastPut };
    }
    await fulfillJson(route, 200, saved);
  });

  return {
    getLastPut: () => lastPut,
  };
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test.describe("Runtime settings", () => {
  test("navigates from Settings, loads cached-skill preferences, and saves changes", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_runtime_save_${Date.now()}@example.com`);
    const runtimeApi = await mockRuntimeSettings(page);

    await page.goto("/settings/profile");
    const settingsNav = page.getByRole("navigation", { name: "Settings" });
    await settingsNav.getByRole("link", { name: "Runtime" }).click();

    await expect(page).toHaveURL(/\/settings\/runtime$/);
    await expect(page.getByRole("heading", { name: "Runtime", level: 1 })).toBeVisible();

    const autoUpdate = page.getByLabel("Automatically update cached skills");
    const refreshHours = page.getByLabel("Refresh interval (hours)");
    const save = page.getByRole("button", { name: "Save runtime" });

    await expect(autoUpdate).toBeChecked();
    await expect(refreshHours).toHaveValue("24");
    await expect(save).toBeDisabled();

    await autoUpdate.uncheck();
    await expect(refreshHours).toBeDisabled();
    await autoUpdate.check();
    await refreshHours.fill("48");
    await expect(save).toBeEnabled();
    await save.click();

    await expect(page.getByText("Runtime settings saved")).toBeVisible();
    await expect(page.getByText("No unsaved changes")).toBeVisible();
    expect(runtimeApi.getLastPut()).toEqual({
      skill_cache_auto_update: true,
      skill_cache_refresh_hours: 48,
    });

    await page.reload();
    await expect(refreshHours).toHaveValue("48");
  });

  test("validates the refresh-hour client boundaries", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_runtime_bounds_${Date.now()}@example.com`);
    await mockRuntimeSettings(page);
    await page.goto("/settings/runtime");

    const refreshHours = page.getByLabel("Refresh interval (hours)");
    const save = page.getByRole("button", { name: "Save runtime" });
    const rangeError = page.getByRole("alert");

    await refreshHours.fill("0");
    await expect(rangeError).toHaveText("skill_cache_refresh_hours must be between 1 and 168");
    await expect(refreshHours).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();

    await refreshHours.fill("169");
    await expect(rangeError).toHaveText("skill_cache_refresh_hours must be between 1 and 168");
    await expect(save).toBeDisabled();

    await refreshHours.fill("1");
    await expect(rangeError).toHaveCount(0);
    await expect(refreshHours).toHaveAttribute("aria-invalid", "false");
    await expect(save).toBeEnabled();

    await refreshHours.fill("168");
    await expect(rangeError).toHaveCount(0);
    await expect(save).toBeEnabled();
  });

  test("keeps unsaved values editable and reports a save error", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_runtime_error_${Date.now()}@example.com`);
    await page.route("**/api/settings/runtime", async (route) => {
      if (route.request().method() === "PUT") {
        await fulfillJson(route, 503, {
          error: { code: "RUNTIME_SETTINGS_UNAVAILABLE", message: "Runtime settings unavailable" },
        });
        return;
      }
      await fulfillJson(route, 200, defaults);
    });
    await page.goto("/settings/runtime");

    const refreshHours = page.getByLabel("Refresh interval (hours)");
    const save = page.getByRole("button", { name: "Save runtime" });
    await expect(refreshHours).toHaveValue("24");
    await refreshHours.fill("72");
    await save.click();

    await expect(page.getByText("Runtime settings unavailable")).toBeVisible();
    await expect(refreshHours).toHaveValue("72");
    await expect(save).toBeEnabled();
    await expect(page.getByText("No unsaved changes")).toHaveCount(0);
  });
});
