// spec: specs/agent-kanban.plan.md
// section: 8.5 Add Repository — successfully add a new repository

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Add Repository — successfully add a new repository", async ({ page }) => {
    // 1. Sign in, navigate to /repositories, and open the Add Repository dialog
    await signUpAndGetBoard(page, `repos_add_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add Repository" }).click();

    // expect: Dialog is open
    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    // 2. Switch to the 'Manual' tab, then type 'test-repo' in Name and
    //    'https://github.com/user/test-repo.git' in Clone URL, then click 'Add Repository'
    await page.getByRole("tab", { name: "Manual" }).click();
    await page.getByRole("textbox", { name: "my-repo" }).fill("test-repo");
    await page.getByRole("textbox", { name: "https://github.com/user/repo." }).fill("https://github.com/user/test-repo.git");
    await page.getByRole("dialog").getByRole("button", { name: "Add Repository" }).click();

    // expect: The dialog closes
    await expect(page.getByRole("heading", { name: "Add Repository" })).not.toBeVisible();

    // expect: The new repository 'test-repo' appears at the top of the repositories list
    await expect(page.getByText("test-repo", { exact: true })).toBeVisible();

    // expect: The total count in the header increments by 1
    await expect(page.getByText("1 total")).toBeVisible();
  });
});
