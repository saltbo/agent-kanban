// spec: specs/agent-kanban.plan.md
// section: 8.4 Add Repository — submit button disabled when fields are empty

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Add Repository — submit button disabled when fields are empty", async ({ page }) => {
    // 1. Sign in, navigate to /repositories, click 'Add Repository' to open the dialog
    await signUpAndGetBoard(page, `repos_valid_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add Repository" }).click();

    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    // Switch to the 'Manual' tab to reveal the form fields and submit button
    await page.getByRole("tab", { name: "Manual" }).click();

    const submitButton = page.getByRole("dialog").getByRole("button", { name: "Add Repository" });
    const nameInput = page.getByRole("textbox", { name: "my-repo" });
    const urlInput = page.getByRole("textbox", { name: "https://github.com/user/repo." });

    // expect: Both Name and Clone URL fields are empty
    await expect(nameInput).toHaveValue("");
    await expect(urlInput).toHaveValue("");

    // 2. Observe the 'Add Repository' submit button state
    // expect: The submit button is disabled when either or both fields are empty
    await expect(submitButton).toBeDisabled();

    // 3. Enter 'my-repo' in Name but leave URL empty
    await nameInput.fill("my-repo");

    // expect: The submit button remains disabled
    await expect(submitButton).toBeDisabled();

    // 4. Enter a URL in the Clone URL field as well
    await urlInput.fill("https://github.com/user/my-repo.git");

    // expect: The submit button becomes enabled
    await expect(submitButton).toBeEnabled();
  });
});
