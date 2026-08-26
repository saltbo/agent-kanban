// spec: specs/agent-kanban.plan.md
// seed: tests/repositories/repos-add-success.spec.ts

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const INSTALL_URL = "https://github.com/apps/agent-kanban/installations/new";

const GITHUB_APP_CONFIG = {
  configured: true,
  slug: "agent-kanban",
  install_url: INSTALL_URL,
};

const INSTALLABLE_REPOS = {
  installed: true,
  repositories: [
    {
      full_name: "acme/web",
      name: "web",
      clone_url: "https://github.com/acme/web.git",
      private: false,
      already_added: false,
    },
    {
      full_name: "acme/api",
      name: "api",
      clone_url: "https://github.com/acme/api.git",
      private: true,
      already_added: true,
    },
  ],
};

const CREATED_REPO = {
  id: "repo_new",
  name: "web",
  url: "https://github.com/acme/web",
  created_at: "2026-06-19T00:00:00Z",
  full_name: "acme/web",
  app_status: "covered",
};

test.describe("Repositories GitHub App", () => {
  test("browse and import a repo from the GitHub App tab", async ({ page }) => {
    // 1. Sign in and navigate to /repositories
    await signUpAndGetBoard(page, `repos_github_app_${Date.now()}@example.com`);

    // 2. Mock GET /api/github-app/config
    await page.route("**/api/github-app/config", (route) => {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GITHUB_APP_CONFIG) });
    });

    // 3. Mock GET /api/github-app/repositories
    await page.route("**/api/github-app/repositories", (route) => {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INSTALLABLE_REPOS) });
    });

    // 4. Mock POST /api/repositories and capture the request body for later assertion
    let capturedPostBody: unknown = null;
    await page.route("**/api/repositories", async (route) => {
      if (route.request().method() === "POST") {
        capturedPostBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(CREATED_REPO) });
      } else {
        await route.continue();
      }
    });

    await page.goto("/repositories");
    await page.getByText("Repositories").first().waitFor({ state: "visible" });

    // 5. Assert the "Install GitHub App" link is visible and has the correct href
    const installLink = page.getByRole("link", { name: "Install GitHub App" });
    await expect(installLink).toBeVisible();
    await expect(installLink).toHaveAttribute("href", INSTALL_URL);

    // 6. Click "Add Repository" to open the dialog
    await page.getByRole("button", { name: "Add Repository" }).click();

    // 7. Assert the dialog opens on the "From GitHub" tab by default
    await expect(page.getByRole("heading", { name: "Add Repository" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "From GitHub" })).toHaveAttribute("aria-selected", "true");

    // 8. Assert acme/web row is present with an enabled "Add" button
    const webRow = page.getByRole("dialog").getByText("acme/web");
    await expect(webRow).toBeVisible();
    const addWebButton = page.getByRole("dialog").getByRole("button", { name: "Add" }).first();
    await expect(addWebButton).toBeEnabled();

    // 9. Assert acme/api row is present with a disabled "Added" button
    const apiRow = page.getByRole("dialog").getByText("acme/api");
    await expect(apiRow).toBeVisible();
    const addedApiButton = page.getByRole("dialog").getByRole("button", { name: "Added" });
    await expect(addedApiButton).toBeDisabled();

    // 10. Click "Add" next to acme/web and assert POST /api/repositories is called with the correct body
    await addWebButton.click();
    await expect.poll(() => capturedPostBody).toEqual({ name: "web", url: "https://github.com/acme/web.git" });

    // 11. Switch to the "Manual" tab
    await page.getByRole("tab", { name: "Manual" }).click();

    // 12. Assert the Name input, Clone URL input, and "Add Repository" submit button are visible
    await expect(page.getByRole("textbox", { name: "my-repo" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "https://github.com/user/repo." })).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Add Repository" })).toBeVisible();
  });
});
