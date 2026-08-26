// spec: specs/agent-kanban.plan.md
// section: 8.2 Repositories page lists repositories with metadata

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Repositories page lists repositories with metadata", async ({ page }) => {
    // 1. Sign in as a user with at least one repository and navigate to /repositories
    await signUpAndGetBoard(page, `repos_list_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });

    // Add a repository first so we have something to list
    await page.getByRole("button", { name: "Add Repository" }).click();
    await page.getByRole("tab", { name: "Manual" }).click();
    await page.getByRole("textbox", { name: "my-repo" }).fill("list-repo");
    await page.getByRole("textbox", { name: "https://github.com/user/repo." }).fill("https://github.com/user/list-repo.git");
    await page.getByRole("dialog").getByRole("button", { name: "Add Repository" }).click();

    // expect: Each repository card shows name, clone URL, task count, and added date
    await expect(page.getByText("list-repo", { exact: true })).toBeVisible();
    await expect(page.getByText("https://github.com/user/list-repo").first()).toBeVisible();
    await expect(page.getByText(/Tasks:/)).toBeVisible();
    await expect(page.getByText(/Added:/)).toBeVisible();

    // expect: The count in the header shows the total number of repositories
    await expect(page.getByText("1 total")).toBeVisible();

    // expect: A 'Remove' button is visible on each repository card
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  });
});
