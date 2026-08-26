// spec: specs/agent-kanban.plan.md
// section: 5.5 Board settings page renders edit details

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Settings Page", () => {
  test("Board settings page renders edit details", async ({ page }) => {
    await signUpAndGetBoard(page, `settings_expand_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    await page.goto(`/boards/${boardId}/settings`);

    await expect(page.getByRole("heading", { name: "Board settings", level: 1 })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Settings", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Labels", exact: true })).toBeVisible();
    await expect(page.getByLabel("Name")).toHaveValue("My Board");
    await expect(page.getByPlaceholder("What is this board for?")).toBeVisible();
    await page.getByLabel("Name").fill("Saved Board");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Board settings saved")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sharing" })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Sharing off" })).toHaveAttribute("aria-checked", "false");
    await page.getByRole("switch", { name: "Sharing off" }).click();
    await expect(page.getByText("Sharing enabled")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Sharing on" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Badge previews")).toBeVisible();
    await expect(page.getByAltText("AK agents badge")).toBeVisible();
    await expect(page.getByAltText("AK tasks badge")).toBeVisible();
    await expect(page.getByAltText("AK tokens badge")).toBeVisible();
    await expect(page.getByText("Share link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy agents" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy tasks" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy tokens" })).toBeVisible();
    await page.getByRole("button", { name: "Copy tokens" }).click();
    await expect(page.getByText("Tokens badge copied")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  });
});
