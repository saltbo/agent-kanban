import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, Page } from "@playwright/test";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

/**
 * Signs up a new user and completes the onboarding flow,
 * then navigates to the actual board page at /boards/:id.
 *
 * Onboarding steps:
 *   0 - DemoBoard (skip to board creation)
 *   1 - Create Board (board name input + "Create Board" button)
 */
export async function signUpAndGetBoard(page: Page, email: string, name = "Test User"): Promise<void> {
  await page.goto("/auth");
  const origin = new URL(page.url()).origin;
  const res = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({ name, email, password: "password123" }),
  });
  if (!res.ok) throw new Error(`Sign up failed: ${res.status} ${await res.text()}`);

  markEmailVerified(email);
  // Retry transient 5xx from the local dev server: under parallel workers the D1 SQLite
  // file can be briefly locked (e.g. by the markEmailVerified UPDATE above or by another
  // worker's sign-up), and wrangler/miniflare surfaces that as a bare 500 from sign-in.
  let signInRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    signInRes = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ email, password: "password123" }),
    });
    if (signInRes.ok || signInRes.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  const finalSignIn = signInRes!;
  if (!finalSignIn.ok) throw new Error(`Sign in failed: ${finalSignIn.status} ${await finalSignIn.text()}`);

  const token = finalSignIn.headers.get("set-auth-token");
  const cookie = sessionCookie(finalSignIn);
  if (!token || !cookie) throw new Error("Sign in did not return a session");

  await page.context().addCookies([{ name: cookie.name, value: cookie.value, url: origin }]);
  await page.evaluate((authToken) => localStorage.setItem("auth-token", authToken), token);
  await page.goto("/onboarding");

  // Wait to land on the onboarding page
  await page.waitForURL(/\/onboarding/);
  await page.getByRole("button", { name: "Skip demo" }).click();
  await expect(page).toHaveURL(/\/boards\/new/);

  // Step 1: create the board and navigate to it.
  await page.getByRole("button", { name: "Create Board" }).click();

  await expect.poll(() => firstBoardId(page)).not.toBeNull();
  const boardId = await firstBoardId(page);

  if (!boardId) throw new Error("No board found after onboarding");

  await page.goto(`/boards/${boardId}`);
  await expect(page).toHaveURL(/\/boards\/.+/);
  // Wait for the board to be fully loaded (column grid visible)
  await expect(page.locator(".hidden.md\\:grid")).toBeVisible();
}

async function firstBoardId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = localStorage.getItem("auth-token");
    const res = await fetch("/api/boards", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const boards = (await res.json()) as { id: string }[];
    return boards[0]?.id ?? null;
  });
}

function markEmailVerified(email: string) {
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", d1DatabasePath(), `UPDATE user SET emailVerified = 1 WHERE email = '${sqlString(email)}';`]);
}

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

function sessionCookie(res: Response): { name: string; value: string } | null {
  const raw = res.headers.get("set-cookie");
  const pair = raw?.split(";")[0];
  if (!pair) return null;
  const [name, value] = pair.split("=");
  return { name, value: decodeURIComponent(value) };
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
