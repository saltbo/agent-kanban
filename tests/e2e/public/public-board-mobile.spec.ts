import { expect, test } from "@playwright/test";
import { seedTask, signInWithRealmrootSession } from "../../helpers/auth";

test("[spec: public-boards/mobile-view] Anonymous visitors switch public Board status tabs on a phone", async ({ page, browser, baseURL }) => {
  await signInWithRealmrootSession(page, "public-mobile@example.test");
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBe(true);
  const { session } = await sessionResponse.json();
  const headers = { "x-csrf-token": session.csrfToken };
  const created = await page.request.post("/api/boards", { headers, data: { name: "Public mobile board", type: "dev" } });
  expect(created.status()).toBe(201);
  const board = await created.json();
  seedTask(board.id, "Public Todo regression");
  const published = await page.request.patch(`/api/boards/${board.id}`, { headers, data: { visibility: "public" } });
  expect(published.ok()).toBe(true);
  const { shareSlug } = await published.json();
  expect(shareSlug).toEqual(expect.any(String));

  const visitor = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    const publicPage = await visitor.newPage();
    await publicPage.goto(`/share/${shareSlug}`);
    const todo = publicPage.getByRole("button", { name: "Todo (1)", exact: true });
    await expect(todo).toBeVisible();
    await expect(publicPage.getByRole("button", { name: "#1 Public Todo regression", exact: true })).toBeVisible();
    await publicPage.getByRole("button", { name: "In Progress (0)", exact: true }).click();
    await expect(publicPage.getByRole("button", { name: "#1 Public Todo regression", exact: true })).not.toBeVisible();
    await todo.click();
    await expect(publicPage.getByRole("button", { name: "#1 Public Todo regression", exact: true })).toBeVisible();
    expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await visitor.close();
  }
});
