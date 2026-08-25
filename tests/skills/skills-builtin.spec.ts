// spec: Built-in tab lists repository-shipped skills read-only; View opens a dialog with the raw SKILL.md content
// note: GET /api/skills/builtin reads the repo's skills/ directory in local dev, so agent-kanban is always present

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Built-in skills are listed read-only", async ({ page }) => {
    // 1. Sign up, navigate to /skills, and switch to the Built-in tab
    await signUpAndGetBoard(page, `skillsbuiltin_${Date.now()}@example.com`);
    await page.goto("/skills");
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    await page.getByRole("tab", { name: "Built-in" }).click();

    // expect: Repository-shipped skills are listed with a Read-only badge
    const row = page.locator("div.bg-surface-secondary", { has: page.getByText("agent-kanban", { exact: true }) }).first();
    await expect(row).toBeVisible();
    await expect(row.getByText("Read-only", { exact: true })).toBeVisible();

    // 2. Click View on the agent-kanban skill row
    await row.getByRole("button", { name: "View" }).click();

    // expect: The dialog shows the raw SKILL.md content including its frontmatter
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const content = dialog.locator("pre");
    await expect(content).toBeVisible();
    await expect(content).toContainText("---");
    await expect(content).toContainText("name: agent-kanban");
  });
});
