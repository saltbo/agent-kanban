// spec: specs/agent-kanban.plan.md
// section: 6.11 Machine not found shows graceful error state

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  test("Machine not found shows graceful error state", async ({ page }) => {
    // 1. Sign in and navigate to /machines/nonexistent-id
    await signUpAndGetBoard(page, `machine_notfound_${Date.now()}@example.com`);
    await page.goto("/machines/nonexistent-id");

    // expect: The page shows 'Machine not found.' text in the content area
    await expect(page.getByText("Machine not found.")).toBeVisible({ timeout: 15_000 });

    // expect: The header is still rendered correctly
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("link", { name: "Agent Kanban" })).toBeVisible();
  });
});
