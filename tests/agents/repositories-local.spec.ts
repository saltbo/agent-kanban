// E2E: repositories page — register a local git path via the manual tab and
// verify the Local badge, then remove the repo through the UI so the spec
// leaves no residue in the shared dev database.

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

// The test repo itself is a guaranteed absolute git path on this machine.
const LOCAL_REPO_PATH = "/home/liuyubo/agent-kanban";

test.describe("Repositories Page", () => {
  test("registers a local git path and shows a Local badge", async ({ page }) => {
    const repoName = `e2e-local-${Date.now()}`;

    // 1. Sign in and navigate to /repositories
    await signUpAndGetBoard(page, `repos_local_${Date.now()}@example.com`);
    await page.goto("/repositories");
    await page.getByRole("heading", { name: "Repositories", level: 1 }).waitFor({ state: "visible" });

    // 2. Register a local repo via the 'Manual' tab ('Clone URL or local path')
    await page.getByRole("button", { name: "Add Repository" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Add Repository" })).toBeVisible();

    await dialog.getByRole("tab", { name: "Manual" }).click();
    await dialog.getByRole("textbox", { name: "my-repo" }).fill(repoName);
    await dialog.getByRole("textbox", { name: "https://github.com/user/repo." }).fill(LOCAL_REPO_PATH);
    await dialog.getByRole("button", { name: "Add Repository" }).click();

    // expect: dialog closes and the repo appears with a 'Local' badge and the path
    await expect(dialog).toBeHidden();
    const repoCard = page.locator("div.bg-surface-secondary", { hasText: repoName });
    await expect(repoCard.getByText(repoName, { exact: true })).toBeVisible();
    await expect(repoCard.getByText("Local", { exact: true })).toBeVisible();
    await expect(repoCard.getByText(LOCAL_REPO_PATH).first()).toBeVisible();

    // 3. Cleanup: remove the repo via the UI (card 'Remove' + confirm dialog)
    await repoCard.getByRole("button", { name: "Remove" }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Remove Repository" });
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Remove" }).click();

    await expect(page.getByText(repoName, { exact: true })).toHaveCount(0);
  });
});
