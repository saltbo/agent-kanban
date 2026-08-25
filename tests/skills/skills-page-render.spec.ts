// spec: /skills renders heading, Custom/Built-in tabs, and the custom empty state for a fresh user

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Skills Page", () => {
  test("Skills page renders tabs and empty state", async ({ page }) => {
    // 1. Sign up and navigate to /skills
    await signUpAndGetBoard(page, `skillsrender_${Date.now()}@example.com`);
    await page.goto("/skills");

    // expect: The Skills heading, custom count, and New Skill button are visible
    await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
    await expect(page.getByText("0 custom")).toBeVisible();
    await expect(page.getByRole("button", { name: "New Skill" })).toBeVisible();

    // expect: Custom and Built-in tabs are visible
    await expect(page.getByRole("tab", { name: "Custom" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Built-in" })).toBeVisible();

    // expect: The custom empty state is shown on the default Custom tab
    await expect(page.getByText("No custom skills yet.")).toBeVisible();
    await expect(page.getByText(/Custom skills are referenced from agents as/)).toBeVisible();
  });
});
