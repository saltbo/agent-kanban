// spec: specs/agent-kanban.plan.md
// section: 7.15 Agent detail — Mission tab shows active task or 'No active mission'

import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

test.describe("Agents Page", () => {
  test("Agent detail — Mission tab shows 'No active mission'", async ({ page }) => {
    // 1. Sign in and navigate to an agent that has no active task assigned
    await signUpAndGetBoard(page, `agent_mission_${Date.now()}@example.com`);
    await page.goto("/agents");

    await page.getByText("Quality Goalkeeper").first().waitFor({ state: "visible" });
    await page.getByRole("link", { name: /Quality Goalkeeper/ }).click();
    await expect(page).toHaveURL(/\/agents\/.+/);

    await page.getByText("← Agents").first().waitFor({ state: "visible" });

    // Mission tab is active by default
    await expect(page.getByRole("button", { name: "Mission" })).toBeVisible();

    // expect: The Mission tab content shows 'No active mission.'
    await expect(page.getByText("No active mission.")).toBeVisible();
  });

  test("Agent detail — Mission task exposes sibling board and PR links", async ({ page }) => {
    const nestingErrors: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && (text.includes("validateDOMNesting") || text.includes("cannot be a descendant"))) {
        nestingErrors.push(text);
      }
    });

    await signUpAndGetBoard(page, `agent_mission_links_${Date.now()}@example.com`);
    const boardId = new URL(page.url()).pathname.split("/").at(-1)!;
    const prUrl = "https://github.com/example/mission-repo/pull/42";

    await page.route("**/api/tasks?assigned_to=*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: "mission-link-task",
            board_id: boardId,
            title: "Fix nested mission links",
            status: "in_progress",
            repository_name: "mission-repo",
            pr_url: prUrl,
          },
        ]),
      }),
    );

    await page.goto("/agents");
    await page.getByText("Quality Goalkeeper").first().waitFor({ state: "visible" });
    await page.getByRole("link", { name: /Quality Goalkeeper/ }).click();

    const boardLink = page.getByRole("link", { name: /Fix nested mission links/ });
    const prLink = page.getByRole("link", { name: "PR →" });
    await expect(boardLink).toHaveAttribute("href", `/boards/${boardId}`);
    await expect(prLink).toHaveAttribute("href", prUrl);
    await expect(prLink).toHaveAttribute("target", "_blank");
    await expect(prLink).toHaveAttribute("rel", "noopener noreferrer");

    await expect(page.locator("a a")).toHaveCount(0);
    expect(
      await boardLink.evaluate((link) => {
        const pr = link.parentElement?.querySelector('a[target="_blank"]');
        return !!pr && pr.parentElement === link.parentElement && !link.contains(pr);
      }),
    ).toBe(true);
    expect(nestingErrors).toEqual([]);

    await boardLink.click();
    await expect(page).toHaveURL(new RegExp(`/boards/${boardId}$`));
  });
});
