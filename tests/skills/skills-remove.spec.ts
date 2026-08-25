// spec: remove a custom skill via the per-row Remove button and confirmation dialog

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Remove a custom skill", async ({ page }) => {
    // 1. Sign up, navigate to /skills, and create a custom skill via the New Skill dialog
    await signUpAndGetBoard(page, `skillsremove_${Date.now()}@example.com`);
    await page.goto("/skills");

    const name = `e2e-skill-${Date.now()}`;
    await page.getByRole("button", { name: "New Skill" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible();
    await createDialog.getByPlaceholder("my-skill").fill(name);
    await createDialog.getByPlaceholder("When to use this skill").fill("Skill to remove");
    await createDialog.getByPlaceholder(/Instructions for the agent/).fill("# To be removed");
    await createDialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page.getByText(`ak@${name}`, { exact: true })).toBeVisible();

    // 2. Click Remove on the skill row
    await page.getByRole("button", { name: "Remove" }).click();

    // expect: A confirmation dialog appears naming the skill
    const confirmDialog = page.getByRole("dialog");
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText("Remove Skill")).toBeVisible();
    await expect(confirmDialog.getByText(name, { exact: true })).toBeVisible();

    // 3. Confirm the removal
    await confirmDialog.getByRole("button", { name: "Remove" }).click();

    // expect: The dialog closes, the skill is gone, and the empty state returns
    await expect(confirmDialog).toBeHidden();
    await expect(page.getByText("No custom skills yet.")).toBeVisible();
    await expect(page.getByText("0 custom")).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  });
});
