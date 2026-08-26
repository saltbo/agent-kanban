// spec: specs/agent-kanban.plan.md
// section: 6.1 Machines page renders correctly with empty state

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Machines Page", () => {
  test("Machines page renders correctly with empty state", async ({ page }) => {
    // 1. Sign in as a user with no machines registered and navigate to /machines
    await signUpAndGetBoard(page, `machines_empty_${Date.now()}@example.com`);
    await page.goto("/machines");

    // expect: Page heading 'Machines' is displayed
    await expect(page.getByRole("heading", { name: "Machines", level: 1 })).toBeVisible();

    // expect: A count of '0 online' is shown
    await expect(page.getByText("0 online")).toBeVisible();

    // expect: An 'Add Machine' button is present
    await expect(page.getByRole("button", { name: "Add Machine" }).first()).toBeVisible();

    // Wait for loading to complete
    await expect(page.getByText("No machines registered.")).toBeVisible();

    // expect: The empty state text 'No machines registered.' is shown
    await expect(page.getByText("No machines registered.")).toBeVisible();

    // expect: A link to 'Add Machine' in the empty state text is visible
    await expect(page.getByRole("button", { name: "Add Machine" }).nth(1)).toBeVisible();
  });
});
