// E2E: board task management — create, edit, and delete tasks via the WebUI.
//
// Serial mode: tests share the dev D1 (Miniflare SQLite); parallel page
// sessions against it intermittently 500 on SQLite lock contention.

import { expect, type Page, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe.configure({ mode: "serial" });

// The board renders both a desktop grid and a mobile single-column layout;
// only one is visible at a time, so scope card locators to the visible column.
function todoColumn(page: Page) {
  return page.locator('[data-column-status="todo"]:visible');
}

function taskCard(page: Page, title: string) {
  return todoColumn(page).locator("[data-task-id]", { hasText: title });
}

// Boards created during onboarding are type "dev", and the API rejects
// dev-board tasks without a repository_id ("repository_id is required for
// dev board tasks"), so each test user registers a repository up front.
// The dialog's repositories query fires when BoardPage mounts (staleTime
// 60s), so reload afterwards to pick up the new repository.
async function registerRepository(page: Page) {
  await page.evaluate(async () => {
    const token = localStorage.getItem("auth-token");
    const res = await fetch("/api/repositories", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "e2e-repo", url: "https://github.com/e2e/task-management" }),
    });
    if (!res.ok) throw new Error(`Repository registration failed: ${res.status} ${await res.text()}`);
  });
  await page.reload();
  await expect(page.locator(".hidden.md\\:grid")).toBeVisible();
}

async function createTaskViaUI(page: Page, title: string, description?: string) {
  await page.getByRole("button", { name: "+ New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();

  await dialog.locator("#task-title").fill(title);
  if (description) {
    await dialog.locator("#task-description").fill(description);
  }

  // Repository is required on dev boards — pick the registered repo.
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "e2e-repo" }).click();

  await dialog.getByRole("button", { name: "Create task" }).click();

  await expect(dialog).toBeHidden();
  await expect(taskCard(page, title)).toBeVisible();
}

async function openTaskSheet(page: Page, title: string) {
  await taskCard(page, title).click();
  // The sheet's accessible name is the task title (sr-only SheetTitle).
  const sheet = page.getByRole("dialog", { name: title });
  await expect(sheet).toBeVisible();
  // Wait for the task query to resolve and the header to render.
  await expect(sheet.locator("span.text-lg")).toHaveText(title);
  return sheet;
}

test.describe("Board task management", () => {
  test("creates a task from the board UI into the Todo column", async ({ page }) => {
    const title = "E2E test task";
    await signUpAndGetBoard(page, `taskmgmt_create_${Date.now()}@example.com`);
    await registerRepository(page);

    await createTaskViaUI(page, title, "Created by the E2E task-management spec");

    await expect(taskCard(page, title)).toBeVisible();
  });

  test("edits a task title from the task detail sheet", async ({ page }) => {
    const title = "E2E edit me";
    const newTitle = "E2E edited title";
    await signUpAndGetBoard(page, `taskmgmt_edit_${Date.now()}@example.com`);
    await registerRepository(page);
    await createTaskViaUI(page, title);

    const sheet = await openTaskSheet(page, title);

    await sheet.getByRole("button", { name: "Edit", exact: true }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit task" });
    await expect(editDialog).toBeVisible();

    await editDialog.locator("#task-title").fill(newTitle);
    await editDialog.getByRole("button", { name: "Save" }).click();
    await expect(editDialog).toBeHidden();

    // Sheet header reflects the new title after the task query refreshes.
    const renamedSheet = page.getByRole("dialog", { name: newTitle });
    await expect(renamedSheet.locator("span.text-lg")).toHaveText(newTitle);

    // Board card updates after the board refresh.
    await expect(taskCard(page, newTitle)).toBeVisible();
  });

  test("deletes a task from the task detail sheet", async ({ page }) => {
    const title = "E2E delete me";
    await signUpAndGetBoard(page, `taskmgmt_delete_${Date.now()}@example.com`);
    await registerRepository(page);
    await createTaskViaUI(page, title);

    const sheet = await openTaskSheet(page, title);

    await sheet.getByRole("button", { name: "Delete", exact: true }).click();
    const confirmDialog = page.getByRole("dialog", { name: "Delete task" });
    await expect(confirmDialog).toBeVisible();

    await confirmDialog.getByRole("button", { name: "Delete task", exact: true }).click();

    // Sheet closes and the card is gone from the board.
    await expect(sheet).toBeHidden();
    await expect(page.locator("[data-task-id]", { hasText: title })).toHaveCount(0);
  });
});
