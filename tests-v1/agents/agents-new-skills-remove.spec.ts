// spec: specs/agent-kanban.plan.md
// section: 7.9 Agent creation — remove a skill tag

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — remove a skill tag", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click 'Custom', add a skill using the Skills field
    await signUpAndGetBoard(page, `agents_rmskill_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    const skillsInput = page.getByRole("textbox", { name: "owner/repo[#ref]@skill-name" });
    await skillsInput.click();
    await skillsInput.fill("owner/skills@python");
    await page.keyboard.press("Enter");

    // expect: A skill tag is shown
    const workflowGroup = page.getByRole("group", { name: "Workflow" });
    await expect(workflowGroup.getByText("owner/skills@python")).toBeVisible();

    // 2. Click the remove button on the skill tag chip
    await workflowGroup.getByRole("button").click();

    // expect: The tag is removed from the Skills field
    await expect(workflowGroup.getByText("owner/skills@python")).not.toBeVisible();

    // expect: The skills input placeholder is visible again
    await expect(skillsInput).toBeVisible();
  });
});
