import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../../helpers/auth";

test("[spec: agents/primary-navigation] exposes Agents and Machines as primary navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signUpAndGetBoard(page, `headerresources_${Date.now()}@example.com`);

  const header = page.locator("header");
  const navigation = header.getByRole("navigation", { name: "Resource navigation" });
  const agentsLink = navigation.getByRole("link", { name: "Agents", exact: true });
  const machinesLink = navigation.getByRole("link", { name: "Machines", exact: true });

  await expect(agentsLink).toBeVisible();
  await expect(machinesLink).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await agentsLink.click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(agentsLink).toHaveAttribute("aria-current", "page");
  await expect(machinesLink).not.toHaveAttribute("aria-current", "page");

  await machinesLink.click();
  await expect(page).toHaveURL(/\/machines$/);
  await expect(machinesLink).toHaveAttribute("aria-current", "page");
  await expect(agentsLink).not.toHaveAttribute("aria-current", "page");

  await page.setViewportSize({ width: 375, height: 720 });
  await expect(agentsLink).toBeVisible();
  await expect(machinesLink).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await agentsLink.click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(agentsLink).toHaveAttribute("aria-current", "page");

  await machinesLink.click();
  await expect(page).toHaveURL(/\/machines$/);
  await expect(machinesLink).toHaveAttribute("aria-current", "page");

  const accountTrigger = header.locator("button").filter({ has: page.locator('[data-slot="avatar"]') });
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu");
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole("menuitem", { name: "Agents", exact: true })).toHaveCount(0);
  await expect(accountMenu.getByRole("menuitem", { name: "Machines", exact: true })).toHaveCount(0);
});
