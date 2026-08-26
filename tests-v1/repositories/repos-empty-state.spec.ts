// spec: specs/agent-kanban.plan.md
// section: 8.1 Repositories page renders empty state with CLI instructions

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Repositories page renders empty state with CLI instructions", async ({ page }) => {
    // 1. Sign in as a user with no repositories and navigate to /repositories
    await signUpAndGetBoard(page, `repos_empty_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });

    // expect: Page heading 'Repositories' is displayed with '0 total' count
    await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
    await expect(page.getByText("0 total")).toBeVisible();

    // expect: An 'Add Repository' button is present in the header
    await expect(page.getByRole("button", { name: "Add Repository" })).toBeVisible();

    // expect: The empty state shows 'No repositories registered.'
    await expect(page.getByText("No repositories registered.")).toBeVisible();
  });
});
