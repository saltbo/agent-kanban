// spec: specs/agent-kanban.plan.md
// section: 8.7 Remove a repository

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Remove a repository", async ({ page }) => {
    // 1. Sign in, navigate to /repositories with at least one repository present
    await signUpAndGetBoard(page, `repos_remove_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });

    // Add a repository so we have one to remove
    await page.getByRole("button", { name: "Add Repository" }).click();
    await page.getByRole("tab", { name: "Manual" }).click();
    await page.getByRole("textbox", { name: "my-repo" }).fill("remove-me");
    await page.getByRole("textbox", { name: "https://github.com/user/repo." }).fill("https://github.com/user/remove-me.git");
    await page.getByRole("dialog").getByRole("button", { name: "Add Repository" }).click();

    // expect: Repository cards are shown, each with a 'Remove' button
    await expect(page.getByText("remove-me", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(page.getByText("1 total")).toBeVisible();

    // 2. Click the 'Remove' button on a repository card — opens confirmation dialog
    await page.getByRole("button", { name: "Remove" }).click();

    // expect: A 'Remove Repository' confirmation dialog appears
    await expect(page.getByRole("heading", { name: "Remove Repository" })).toBeVisible();

    // 3. Confirm removal by clicking 'Remove' in the dialog footer
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();

    // expect: The confirmation dialog closes and the repository card disappears
    await expect(page.getByRole("heading", { name: "Remove Repository" })).not.toBeVisible();
    await expect(page.getByText("remove-me", { exact: true })).not.toBeVisible();

    // expect: The total count in the header decrements by 1
    await expect(page.getByText("0 total")).toBeVisible();
  });
});
