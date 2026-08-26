// spec: specs/agent-kanban.plan.md
// section: 5.8 Board settings — delete with ID confirmation dialog

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board settings — delete with ID confirmation dialog", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_delete_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    await page.goto(`/boards/${boardId}/settings`);

    const deleteButton = page.getByRole("button", { name: "Delete" });
    await expect(deleteButton).toBeVisible();

    await deleteButton.click();

    const dialog = page.getByRole("dialog", { name: "Delete board" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(boardId)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete board" })).toBeDisabled();

    await dialog.getByLabel("Board ID confirmation").fill("wrong-id");
    await expect(dialog.getByRole("button", { name: "Delete board" })).toBeDisabled();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog", { name: "Delete board" }).getByLabel("Board ID confirmation").fill(boardId);
    await page.getByRole("dialog", { name: "Delete board" }).getByRole("button", { name: "Delete board" }).click();

    await expect
      .poll(async () => {
        return page.evaluate(async () => {
          const res = await fetch("/api/boards", { credentials: "include" });
          const boards = (await res.json()) as { id: string }[];
          return boards.map((board) => board.id);
        });
      })
      .not.toContain(boardId);
    await expect(page).not.toHaveURL(`/boards/${boardId}/settings`);
  });
});
