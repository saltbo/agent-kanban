// spec: specs/agent-kanban.plan.md
// section: 3.1 Board page renders five kanban columns

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Board Page", () => {
  test("Board page renders five kanban columns", async ({ page }) => {
    // 1. Sign in with valid credentials and navigate to a board at /boards/:boardId
    await signUpAndGetBoard(page, `boardcolumns_${Date.now()}@example.com`);

    // expect: The board page is displayed
    await expect(page).toHaveURL(/\/boards\/.+/);

    // expect: Five columns are visible: Todo, In Progress, In Review, Done, Cancelled
    // Desktop view - columns are visible in the hidden.md:grid container
    const columnGrid = page.locator(".hidden.md\\:grid");
    await expect(columnGrid).toBeVisible();

    // Column headers are inside the desktop grid
    await expect(columnGrid.getByText("Todo")).toBeVisible();
    await expect(columnGrid.getByText("In Progress")).toBeVisible();
    await expect(columnGrid.getByText("In Review")).toBeVisible();
    await expect(columnGrid.getByText("Done")).toBeVisible();
    await expect(columnGrid.getByText("Cancelled")).toBeVisible();

    // Five column dividers should be present
    const columns = columnGrid.locator("> div");
    await expect(columns).toHaveCount(5);

    // Each column header has a task count badge (span directly in the column header row)
    // Column header structure: flex items-center justify-between > span.font-mono.text-[11px]
    const countBadges = columnGrid.locator("> div > div.flex > span.font-mono");
    await expect(countBadges).toHaveCount(5);
  });
});
