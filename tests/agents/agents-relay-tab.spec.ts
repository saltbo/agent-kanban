// spec: Agents Relay tab
// section: Relay tab shows relay quota panel with import and add actions

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Relay tab", () => {
  test("Relay tab shows relay quota panel with import and add actions", async ({ page }) => {
    // 1. Sign in
    await signUpAndGetBoard(page, `agents_relay_${Date.now()}@example.com`);

    // 2. Navigate to /agents
    await page.goto("/agents");

    // 3. Click the "Relay" tab trigger
    await page.getByRole("tab", { name: "Relay" }).click();

    // 4. Relay panel appears with description text and both action buttons
    await expect(page.getByText("Live quota for Claude Code relay endpoints")).toBeVisible();
    await expect(page.getByRole("button", { name: "Import JSON" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add relay" })).toBeVisible();

    // 5. Click "Import JSON" — the import dialog opens
    await page.getByRole("button", { name: "Import JSON" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Import relays from JSON" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Relay config JSON" })).toBeVisible();

    // 6. Close the dialog via Cancel
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });
});
