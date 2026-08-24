// spec: header top nav contains Agents, Machines, Repositories, Skills; Skills navigates to /skills

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Header and Navigation", () => {
  test("Header navigation shows Skills link", async ({ page }) => {
    // 1. Sign up and land on a board page
    await signUpAndGetBoard(page, `headerskillsnav_${Date.now()}@example.com`);

    const header = page.locator("header");

    // expect: The top nav contains Agents, Machines, Repositories, and Skills links
    await expect(header.getByRole("link", { name: "Agents", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: "Machines", exact: true })).toBeVisible();
    await expect(header.getByRole("link", { name: "Repositories", exact: true })).toBeVisible();
    const skillsLink = header.getByRole("link", { name: "Skills", exact: true });
    await expect(skillsLink).toBeVisible();

    // 2. Click the Skills nav link
    await skillsLink.click();

    // expect: The user is navigated to /skills and the Skills page is displayed
    await expect(page).toHaveURL(/\/skills/);
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  });
});
