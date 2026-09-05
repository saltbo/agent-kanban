import { expect, test } from "@playwright/test";

test("[spec: browser-shell/local-demo] Demo Agent activity never requests live demo profiles", async ({ page }) => {
  const demoRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/agents/demo-") || url.pathname.startsWith("/.well-known/")) demoRequests.push(url.pathname);
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Orchestrate AI Coding Agents on a Kanban Board" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open chat with Atlas" }).first()).toBeVisible();
  await page.clock.runFor(15_000);
  expect(demoRequests).toEqual([]);
});

test("[spec: browser-shell/documentation] Documentation points to the project README", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Documentation", exact: true })).toHaveAttribute(
    "href",
    "https://github.com/saltbo/agent-kanban#readme",
  );
});

test("[spec: browser-shell/not-found] Unknown pages explain the error and let visitors return home", async ({ page }) => {
  await page.goto("/this-page-does-not-exist");
  await expect(page.getByRole("heading", { name: /page not found/i })).toBeVisible();
  await page.getByRole("link", { name: /home/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Orchestrate AI Coding Agents on a Kanban Board" })).toBeVisible();
});

test("[spec: browser-shell/theme-preference] First visit is dark and saved light dark and system preferences survive reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/auth");
  await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);

  for (const preference of ["light", "dark", "system"]) {
    await page.evaluate((theme) => localStorage.setItem("theme", theme), preference);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Sign in with Realmroot" })).toBeVisible();
    if (preference === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
    else await expect(page.locator("html")).not.toHaveClass(/dark/);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});
