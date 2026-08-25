// spec: edit a custom skill via the per-row Edit button; updated description is shown in the list

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Edit a custom skill", async ({ page }) => {
    // 1. Sign up, navigate to /skills, and create a custom skill via the New Skill dialog
    await signUpAndGetBoard(page, `skillsedit_${Date.now()}@example.com`);
    await page.goto("/skills");

    const name = `e2e-skill-${Date.now()}`;
    await page.getByRole("button", { name: "New Skill" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toBeVisible();
    await createDialog.getByPlaceholder("my-skill").fill(name);
    await createDialog.getByPlaceholder("When to use this skill").fill("Original description");
    await createDialog.getByPlaceholder(/Instructions for the agent/).fill("# Original body");
    await createDialog.getByRole("button", { name: "Create Skill" }).click();
    await expect(page.getByText(`ak@${name}`, { exact: true })).toBeVisible();

    // 2. Click Edit on the skill row and change the description
    await page.getByRole("button", { name: "Edit" }).click();

    const editDialog = page.getByRole("dialog");
    await expect(editDialog).toBeVisible();
    await expect(editDialog.getByText(`Edit ${name}`)).toBeVisible();
    await editDialog.getByPlaceholder("When to use this skill").fill("Updated description");

    // 3. Save the changes
    await editDialog.getByRole("button", { name: "Save Changes" }).click();

    // expect: The dialog closes and the updated description is shown in the Custom list
    await expect(editDialog).toBeHidden();
    await expect(page.getByText("Updated description")).toBeVisible();
    await expect(page.getByText("Original description")).toHaveCount(0);
  });
});
