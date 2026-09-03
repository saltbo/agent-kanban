import { expect, type Locator, test } from "@playwright/test";
import { signUpAndGetBoard } from "../../helpers/auth";

async function expectNeutralActiveState(activeLink: Locator, inactiveLink: Locator) {
  await expect(activeLink).toHaveClass(/(?:^|\s)bg-surface-tertiary(?:\s|$)/);
  await expect(activeLink).toHaveClass(/(?:^|\s)text-content-primary(?:\s|$)/);
  await expect(activeLink).not.toHaveClass(/(?:^|\s)bg-accent-soft(?:\s|$)/);
  await expect(activeLink).not.toHaveClass(/(?:^|\s)text-accent(?:\s|$)/);

  const [activeStyles, inactiveStyles] = await Promise.all(
    [activeLink, inactiveLink].map((link) =>
      link.evaluate((element) => {
        const styles = getComputedStyle(element);
        return { backgroundColor: styles.backgroundColor, color: styles.color, height: styles.height };
      }),
    ),
  );

  expect(activeStyles.height).toBe("28px");
  expect(inactiveStyles.height).toBe("28px");
  expect(activeStyles.backgroundColor).not.toBe(inactiveStyles.backgroundColor);
  expect(activeStyles.color).not.toBe(inactiveStyles.color);
}

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
  await expectNeutralActiveState(agentsLink, machinesLink);

  await machinesLink.click();
  await expect(page).toHaveURL(/\/machines$/);
  await expect(machinesLink).toHaveAttribute("aria-current", "page");
  await expect(agentsLink).not.toHaveAttribute("aria-current", "page");
  await expectNeutralActiveState(machinesLink, agentsLink);

  await page.setViewportSize({ width: 375, height: 720 });
  await expect(agentsLink).toBeVisible();
  await expect(machinesLink).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await agentsLink.click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(agentsLink).toHaveAttribute("aria-current", "page");
  await expectNeutralActiveState(agentsLink, machinesLink);

  await machinesLink.click();
  await expect(page).toHaveURL(/\/machines$/);
  await expect(machinesLink).toHaveAttribute("aria-current", "page");
  await expectNeutralActiveState(machinesLink, agentsLink);

  const accountTrigger = header.locator("button").filter({ has: page.locator('[data-slot="avatar"]') });
  await accountTrigger.click();
  const accountMenu = page.getByRole("menu");
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole("menuitem", { name: "Agents", exact: true })).toHaveCount(0);
  await expect(accountMenu.getByRole("menuitem", { name: "Machines", exact: true })).toHaveCount(0);
});
