// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 1.4 legacy-agent-and-administration-surfaces-stay-absent
import { expect, test } from "@playwright/test";
import { readyAgent, routeAmaAgents, signIn } from "./product-fixtures";

test("restored product UX does not restore v1 identity, daemon, or administration surfaces", async ({ page }) => {
  await signIn(page);
  await routeAmaAgents(page, [readyAgent], []);

  await page.goto("/agents?connection=ama-e2e");
  const interactiveLegacySurface = page
    .getByRole("link", { name: /leader|worker|subagent|daemon|ak start|github app|admin|maintainer/i })
    .or(page.getByRole("button", { name: /leader|worker|subagent|daemon|ak start|github app|admin|maintainer/i }));
  await expect(interactiveLegacySurface).toHaveCount(0);
  await expect(page.getByText(/\b(?:leader|worker|subagent)\b/i)).toHaveCount(0);
  await expect(page.getByText(/\bak start\b|agent-kanban start|AK daemon|GitHub App|board maintainer/i)).toHaveCount(0);

  await page.goto("/admin");
  await expect(page).not.toHaveURL(/\/admin(?:\/|$)/);
  await page.goto("/boards/board-main/maintainers/legacy");
  await expect(page).not.toHaveURL(/\/maintainers(?:\/|$)/);
});
