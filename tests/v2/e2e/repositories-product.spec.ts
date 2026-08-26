// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 5.1 repository-list-create-and-remove
import { expect, test } from "@playwright/test";
import { collection, fulfillJson, signIn } from "./product-fixtures";

test("Repositories retain list and modal management while AK remains authoritative", async ({ page }) => {
  await signIn(page);
  await page.route(/\/api\/repositories(?:\?.*)?$/, (route) => {
    if (route.request().method() === "POST") {
      return fulfillJson(
        route,
        {
          id: "repository-created",
          name: "New repository",
          url: "https://example.test/new.git",
          defaultBranch: "main",
        },
        201,
      );
    }
    return fulfillJson(
      route,
      collection([
        {
          id: "repository-main",
          name: "agent-kanban",
          url: "https://example.test/agent-kanban.git",
          defaultBranch: "main",
          taskCount: 5,
        },
      ]),
    );
  });

  await page.goto("/repositories");
  await expect(page.getByRole("heading", { name: "Repositories", level: 1 })).toBeVisible();
  await expect(page.getByText("agent-kanban", { exact: true })).toBeVisible();
  await expect(page.getByText("https://example.test/agent-kanban.git")).toBeVisible();
  await expect(page.getByText(/Added:/i)).toBeVisible();

  const trigger = page.getByRole("button", { name: "Add Repository" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add Repository" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add Repository" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
});
