// spec: create a custom skill via the New Skill dialog; it appears in the Custom list with an ak@name badge

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Create a custom skill", async ({ page }) => {
    // 1. Sign up and navigate to /skills
    await signUpAndGetBoard(page, `skillscreate_${Date.now()}@example.com`);
    await page.goto("/skills");
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();

    // 2. Open the New Skill dialog and fill in name, description, and body
    const name = `e2e-skill-${Date.now()}`;
    await page.getByRole("button", { name: "New Skill" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByPlaceholder("my-skill").fill(name);
    await dialog.getByPlaceholder("When to use this skill").fill("E2E test skill");
    await dialog.getByPlaceholder(/Instructions for the agent/).fill("# E2E Skill\n\nCreated by an e2e test.");

    // 3. Submit the dialog with the Create Skill button
    await dialog.getByRole("button", { name: "Create Skill" }).click();

    // expect: The dialog closes and the skill appears in the Custom list with its ak@name badge
    await expect(dialog).toBeHidden();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByText(`ak@${name}`, { exact: true })).toBeVisible();
    await expect(page.getByText("E2E test skill")).toBeVisible();
    await expect(page.getByText("1 custom")).toBeVisible();
  });
});
