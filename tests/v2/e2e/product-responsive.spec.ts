// spec: tests/v2/e2e/product-experience.plan.md
// scenario: 1.2 responsive-product-navigation
import { expect, test } from "@playwright/test";
import { signIn } from "./product-fixtures";

test("product navigation remains keyboard reachable without overflow at narrow width", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.goto("/boards/board-main");

  const menuButton = page.getByRole("button", { name: "Product navigation" });
  await expect(menuButton).toBeVisible();
  await menuButton.focus();
  await expect(menuButton).toBeFocused();
  await page.keyboard.press("Enter");

  const navigation = page.getByRole("navigation", { name: "Product" });
  for (const destination of ["Boards", "Agents", "Machines", "Repositories", "Settings"]) {
    await expect(navigation.getByRole("link", { name: destination })).toBeVisible();
  }
  await expect(navigation.getByRole("link", { name: "Boards" })).toHaveAttribute("aria-current", "page");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
