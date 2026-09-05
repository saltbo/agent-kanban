import { expect, test } from "@playwright/test";
import { signInWithRealmrootSession } from "../../helpers/auth";

test("[spec: repositories/manual-management] Browsing repositories includes every item beyond the first page", { tag: "@critical" }, async ({
  page,
}) => {
  await signInWithRealmrootSession(page, "pagination@example.test");
  const sessionResponse = await page.request.get("/api/auth/session");
  expect(sessionResponse.ok()).toBe(true);
  const { session } = await sessionResponse.json();
  for (let index = 1; index <= 51; index++) {
    const name = `pagination-repo-${String(index).padStart(2, "0")}`;
    const response = await page.request.post("/api/repositories", {
      headers: { "x-csrf-token": session.csrfToken },
      data: { name, url: `https://github.com/e2e/${name}` },
    });
    expect(response.status()).toBe(201);
  }

  const firstPage = await page.request.get("/api/repositories");
  expect(firstPage.ok()).toBe(true);
  const result = await firstPage.json();
  expect(result.items).toHaveLength(50);
  expect(result.pagination.nextPageToken).toEqual(expect.any(String));

  await page.goto("/repositories");
  await expect(page.getByText("51 total", { exact: true })).toBeVisible();
  for (let index = 1; index <= 51; index++) {
    await expect(page.getByText(`pagination-repo-${String(index).padStart(2, "0")}`, { exact: true })).toBeVisible();
  }
});
