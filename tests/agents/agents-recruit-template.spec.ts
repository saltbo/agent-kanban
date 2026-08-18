// spec: specs/agent-kanban.plan.md
// section: 7. Agents Page — Recruit from template prefills username and creates the agent

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const TEMPLATES_BASE = "https://raw.githubusercontent.com/saltbo/agent-kanban/main/agents";

test.describe("Agents Page", () => {
  // Serial: both tests run the sign-up + sqlite verify + sign-in flow against
  // the same dev D1 database; running them concurrently intermittently makes
  // the sign-in endpoint return 500 (database locked).
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    // Intercept the upstream template fetches so the test does not depend on
    // GitHub availability. The yaml body intentionally has NO username field —
    // the fix slugifies the template name to prefill the Username input.
    await page.route(`${TEMPLATES_BASE}/index.json`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ slug: "fullstack-developer", name: "Fullstack Developer" }]),
      }),
    );
    await page.route(`${TEMPLATES_BASE}/fullstack-developer.yaml`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/yaml",
        body: [
          "name: Fullstack Developer",
          "bio: Ships features across the stack",
          "role: fullstack-developer",
          "runtime: claude",
          "model: claude-sonnet-4-6",
          "",
        ].join("\n"),
      }),
    );
  });

  async function openRecruitForm(page: import("@playwright/test").Page, email: string) {
    // 1. Sign in, navigate to /agents/new, and click the 'Recruit' card
    await signUpAndGetBoard(page, email);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Recruit Choose from battle-" }).click();

    // expect: The 'Recruit an agent' step shows the template grid
    await expect(page.getByRole("heading", { name: "Recruit an agent" })).toBeVisible();

    // 2. Select the 'Fullstack Developer' template card
    await page.getByRole("button", { name: /Fullstack Developer/ }).click();

    // expect: The form step opens with the heading 'Recruit Fullstack Developer'
    await expect(page.getByRole("heading", { name: "Recruit Fullstack Developer" })).toBeVisible();
  }

  test("Recruit from template prefills username and creates the agent", async ({ page }) => {
    await openRecruitForm(page, `agents_recruittpl_${Date.now()}@example.com`);

    // expect: The Username input is prefilled with the slugified template name
    await expect(page.locator("#agent-username")).toHaveValue("fullstack-developer");

    // Agent usernames are globally unique, so give this run a unique username
    // to keep the spec repeatable against a shared dev database.
    const uniqueUsername = `fsdev-${Date.now().toString(36)}`;
    await page.locator("#agent-username").fill(uniqueUsername);

    // 3. Click the 'Recruit' submit button
    await page.getByRole("button", { name: "Recruit", exact: true }).click();

    // expect: The app navigates to /agents
    await expect(page).toHaveURL(/\/agents$/);

    // expect: The newly created agent appears on the /agents page
    await expect(page.getByRole("heading", { name: "Fullstack Developer", exact: true })).toBeVisible();
    await expect(page.getByText(`@${uniqueUsername}`)).toBeVisible();
  });

  test("Recruit from template shows an explicit error when username is cleared", async ({ page }) => {
    await openRecruitForm(page, `agents_recruittpl_err_${Date.now()}@example.com`);

    // 3. Clear the prefilled Username input
    await page.locator("#agent-username").fill("");

    // 4. Click the 'Recruit' submit button
    await page.getByRole("button", { name: "Recruit", exact: true }).click();

    // expect: An explicit error is shown and the form stays open (no navigation)
    await expect(page.getByText("Username is required (lowercase letters, numbers, hyphens).")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recruit Fullstack Developer" })).toBeVisible();
  });
});
