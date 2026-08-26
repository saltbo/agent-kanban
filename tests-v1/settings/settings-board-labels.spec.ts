// spec: specs/agent-kanban.plan.md
// section: Board labels page — create and delete labels

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board labels page creates and deletes labels", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_labels_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    await page.goto(`/boards/${boardId}/labels`);

    await expect(page.getByRole("heading", { name: "Labels", level: 1 })).toBeVisible();
    await expect(page.getByText("No labels yet.")).toBeVisible();

    await page.getByRole("button", { name: "Add label" }).click();
    await expect(page.getByRole("dialog", { name: "Add label" })).toBeVisible();
    await page.getByRole("button", { name: "Random color" }).click();
    await expect(page.getByLabel("Label color")).not.toHaveValue("#71717a");
    await page.getByLabel("Label name").fill("frontend");
    await page.getByLabel("Label color").fill("#22c55e");
    await page.getByLabel("Label description").fill("Frontend work");
    await expect(page.getByText("frontend", { exact: true })).toBeVisible();
    await expect(page.locator('[title="Frontend work"]')).toBeVisible();
    await page.getByRole("button", { name: "Add label" }).click();

    const labelRow = page.getByRole("listitem").filter({ hasText: "frontend" });
    await expect(labelRow).toBeVisible();
    await expect(labelRow.getByText("frontend", { exact: true })).toBeVisible();
    await expect(labelRow.getByText("Frontend work")).toBeVisible();
    await expect(labelRow.locator('[title="Frontend work"]')).toBeVisible();
    await expect(labelRow.getByRole("button", { name: "Edit label frontend" })).toBeVisible();
    await expect(labelRow.getByRole("button", { name: "Delete label frontend" })).toBeVisible();

    await labelRow.getByRole("button", { name: "Edit label frontend" }).click();
    await expect(page.getByRole("dialog", { name: "Edit label" })).toBeVisible();
    await page.getByLabel("Label name").fill("ui");
    await page.getByLabel("Label description").fill("UI work");
    await expect(page.getByText("ui", { exact: true })).toBeVisible();
    await expect(page.locator('[title="UI work"]')).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();

    const editedRow = page.getByRole("listitem").filter({ hasText: "ui" });
    await expect(editedRow.getByText("ui", { exact: true })).toBeVisible();
    await expect(editedRow.getByText("UI work")).toBeVisible();

    await editedRow.getByRole("button", { name: "Delete label ui" }).click();
    await expect(page.getByRole("dialog", { name: "Delete label" })).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No labels yet.")).toBeVisible();
  });
});
