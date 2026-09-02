import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, Page } from "@playwright/test";

const d1Dir = join(process.cwd(), ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

/**
 * Creates an AK Realmroot-backed web session and completes the onboarding flow,
 * then navigates to the actual board page at /boards/:id.
 *
 * Onboarding steps:
 *   0 - DemoBoard (skip to board creation)
 *   1 - Create Board (board name input + "Create Board" button)
 */
export async function signUpAndGetBoard(page: Page, email: string, name = "Test User"): Promise<void> {
  await signInWithRealmrootSession(page, email, name);

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

export async function signInWithRealmrootSession(page: Page, email: string, name = "Test User"): Promise<void> {
  await page.goto("/auth");
  const origin = new URL(page.url()).origin;
  const session = createRealmrootSession(email, name);
  await page.context().addCookies([
    {
      name: "ak_session",
      value: session.token,
      url: origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/onboarding");

  // Wait to land on the onboarding page
  await page.waitForURL(/\/onboarding/);
}

export function seedTask(boardId: string, title: string, status: "todo" | "in_progress" | "in_review" = "todo"): string {
  const taskId = randomUUID();
  const now = new Date().toISOString();
  execFileSync("sqlite3", [
    "-cmd",
    ".timeout 10000",
    d1DatabasePath(),
    `INSERT INTO tasks (id, board_id, seq, status, title, position, created_at, updated_at)
     SELECT '${taskId}', '${sqlString(boardId)}', COALESCE(MAX(seq), 0) + 1, '${status}', '${sqlString(title)}', 0, '${now}', '${now}'
     FROM tasks
     WHERE board_id = '${sqlString(boardId)}';`,
  ]);
  return taskId;
}

async function firstBoardId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const res = await fetch("/api/boards", { credentials: "include" });
    const boards = (await res.json()) as { id: string }[];
    return boards[0]?.id ?? null;
  });
}

function createRealmrootSession(email: string, name: string): { token: string } {
  const subjectId = `e2e:${randomUUID()}`;
  const tenantId = `user:${subjectId}`;
  const sessionId = randomUUID();
  const token = randomUUID();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const csrfToken = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const sql = `
    BEGIN IMMEDIATE;
    INSERT INTO realmroot_tenants (id) VALUES ('${sqlString(tenantId)}');
    INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role)
      VALUES ('${sqlString(tenantId)}', '${sqlString(subjectId)}', '${sqlString(email)}', '${sqlString(name)}', 'member');
    INSERT INTO realmroot_web_sessions
      (id, token_hash, tenant_id, subject_id, email, name, role, csrf_token, expires_at)
      VALUES (
        '${sqlString(sessionId)}',
        '${tokenHash}',
        '${sqlString(tenantId)}',
        '${sqlString(subjectId)}',
        '${sqlString(email)}',
        '${sqlString(name)}',
        'member',
        '${sqlString(csrfToken)}',
        '${sqlString(expiresAt)}'
      );
    COMMIT;
  `;
  execFileSync("sqlite3", ["-cmd", ".timeout 10000", d1DatabasePath(), sql]);
  return { token };
}

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
