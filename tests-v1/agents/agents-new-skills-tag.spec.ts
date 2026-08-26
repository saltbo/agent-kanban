// spec: specs/agent-kanban.plan.md
// section: 7.8 Agent creation — add a skill tag with Enter key

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent creation — add a skill tag with Enter key", async ({ page }) => {
    // 1. Sign in, navigate to /agents/new, click 'Custom', scroll to the Skills field in the Workflow section
    await signUpAndGetBoard(page, `agents_skills_${Date.now()}@example.com`);
    await page.goto("/agents/new");
    await page.getByRole("button", { name: "Custom Build your own from" }).click();

    // expect: Skills tag input is visible with placeholder text
    const workflowGroup = page.getByRole("group", { name: "Workflow" });
    const skillsInput = workflowGroup.getByRole("textbox", { name: "owner/repo[#ref]@skill-name" });
    await expect(skillsInput).toBeVisible();

    // 2. Click the Skills field, type a valid skill ref, and press Enter
    await skillsInput.click();
    await skillsInput.fill("owner/skills@typescript");
    await page.keyboard.press("Enter");

    // expect: A skill tag chip appears in the input
    await expect(workflowGroup.getByText("owner/skills@typescript")).toBeVisible();

    // expect: The text input clears for the next entry
    // After a tag is added, the placeholder is hidden but the input is still present
    const skillsInputAfterFirstTag = workflowGroup.locator('input[type="text"], input:not([type])').last();
    await expect(skillsInputAfterFirstTag).toHaveValue("");

    // 3. Type another valid skill ref and press Enter
    await skillsInputAfterFirstTag.fill("owner/skills@react");
    await page.keyboard.press("Enter");

    // expect: Two skill tags are now visible
    await expect(workflowGroup.getByText("owner/skills@typescript")).toBeVisible();
    await expect(workflowGroup.getByText("owner/skills@react")).toBeVisible();
  });
});
