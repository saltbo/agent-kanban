// spec: specs/agent-kanban.plan.md
// section: 4.1 Header renders logo, nav links, theme toggle, and user avatar

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Header renders logo, nav links, theme toggle, and user avatar", async ({ page }) => {
    // 1. Sign in and navigate to any protected page (e.g. /settings)
    await signUpAndGetBoard(page, `headerelemts_${Date.now()}@example.com`);
    await page.goto("/settings");

    // expect: The header shows 'Agent Kanban' logo on the left
    const header = page.locator("header");
    await expect(header).toBeVisible();
    await expect(header.getByRole("link", { name: "Agent Kanban" })).toBeVisible();

    // expect: Agents, Machines, Repositories, and Skills nav links are visible on desktop
    await expect(header.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: "Machines", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: "Repositories", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: "Skills", exact: true })).toBeVisible();

    // expect: A user avatar button is visible on the right
    // The avatar is inside a DropdownMenuTrigger button
    const avatarButton = header.locator("button").filter({ has: page.locator('[data-slot="avatar"]') });
    await expect(avatarButton).toBeVisible();

    // expect: A theme toggle icon button is visible on the right
    // The theme toggle is the last button in the header (after the avatar)
    const themeToggle = header.locator("button").last();
    await expect(themeToggle).toBeVisible();
  });
});
