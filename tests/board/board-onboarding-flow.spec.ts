import { expect, test } from "@playwright/test";
import { signInWithRealmrootSession } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Realmroot session completes first-board onboarding without browser credentials", async ({ page }) => {
    await signInWithRealmrootSession(page, `onboarding_${Date.now()}@example.com`, "New User");

    await expect(page.getByRole("button", { name: "Skip demo" })).toBeVisible();
    await page.getByRole("button", { name: "Skip demo" }).click();
    await expect(page).toHaveURL(/\/boards\/new/);

    // expect: Onboarding heading and tagline
    await expect(page.getByRole("heading", { name: "Agent Kanban" })).toBeVisible();
    await expect(page.getByText("Your AI workforce starts here.")).toBeVisible();

    // expect: Board name input pre-filled with "My Board"
    const boardNameInput = page.getByRole("textbox");
    await expect(boardNameInput).toHaveValue("My Board");

    // Create board
    await boardNameInput.clear();
    await boardNameInput.fill("Sprint 1");
    await page.getByRole("button", { name: "Create Board" }).click();

    await expect(page).toHaveURL(/\/boards\/.+/);
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();
    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
});
