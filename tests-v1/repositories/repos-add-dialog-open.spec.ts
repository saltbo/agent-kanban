// spec: specs/agent-kanban.plan.md
// section: 8.3 Open Add Repository dialog

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Open Add Repository dialog", async ({ page }) => {
    // 1. Sign in, navigate to /repositories, and click 'Add Repository'
    await signUpAndGetBoard(page, `repos_dialog_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add Repository" }).click();

    // expect: A modal dialog appears with the title 'Add Repository'
    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    // Switch to the 'Manual' tab to reveal the name/url fields and submit button
    await page.getByRole("tab", { name: "Manual" }).click();

    // expect: A 'Name' input field is present with placeholder 'my-repo'
    await expect(page.getByRole("textbox", { name: "my-repo" })).toBeVisible();

    // expect: A 'Clone URL' input field is present with placeholder 'https://github.com/user/repo.git'
    await expect(page.getByRole("textbox", { name: "https://github.com/user/repo." })).toBeVisible();

    // expect: An 'Add Repository' submit button is present inside the dialog
    await expect(page.getByRole("dialog").getByRole("button", { name: "Add Repository" })).toBeVisible();

    // expect: A close button is visible in the dialog header
    await expect(page.getByRole("button", { name: "Close" })).toBeVisible();
  });
});
