// spec: specs/agent-kanban.plan.md
// section: 8.6 Close Add Repository dialog without submitting

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Repositories Page", () => {
  test("Close Add Repository dialog without submitting", async ({ page }) => {
    // 1. Sign in, navigate to /repositories, open the Add Repository dialog
    await signUpAndGetBoard(page, `repos_close_${Date.now()}@example.com`);
    await page.goto("/repositories");

    await page.getByText("Repositories").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Add Repository" }).click();

    // expect: Dialog is open
    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    // 2. Click the close button in the dialog header
    await page.getByRole("button", { name: "Close" }).click();

    // expect: The dialog closes without adding a repository
    await expect(page.getByRole("heading", { name: "Add Repository" })).not.toBeVisible();

    // expect: The repository list is unchanged (still empty)
    await expect(page.getByText("0 total")).toBeVisible();
    await expect(page.getByText("No repositories registered.")).toBeVisible();

    // 3. Open the dialog again and close it by clicking the backdrop (outside the dialog)
    await page.getByRole("button", { name: "Add Repository" }).click();
    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    // Click on the backdrop area outside the dialog content
    await page.locator('[data-slot="dialog-overlay"]').click({ position: { x: 10, y: 10 } });

    // expect: The dialog closes via backdrop click
    await expect(page.getByRole("heading", { name: "Add Repository" })).not.toBeVisible();
  });
});
