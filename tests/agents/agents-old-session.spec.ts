import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { signUpAndGetBoard } from "../helpers/auth";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

test.describe("Agents with a pre-AMA-grant web session", () => {
  test("keeps read access available and requires a new Realmroot login for AMA operations", async ({ page }) => {
    await signUpAndGetBoard(page, `agents_old_session_${Date.now()}@example.com`);

    const tenantId = await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "include" });
      const session = (await response.json()) as { user: { tenantId: string } };
      return session.user.tenantId;
    });
    execFileSync("sqlite3", [
      "-cmd",
      ".timeout 10000",
      d1DatabasePath(),
      `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id)
       VALUES ('${sqlString(tenantId)}', 'project-old-session')
       ON CONFLICT(tenant_id) DO UPDATE SET ama_project_id = excluded.ama_project_id;`,
    ]);

    const result = await page.evaluate(async () => {
      const agents = await fetch("/api/agents", { credentials: "include" });
      const agentsBody = await agents.json();
      const ama = await fetch("/api/sessions", { credentials: "include" });
      const amaBody = await ama.json();
      return {
        listStatus: agents.status,
        listIsArray: Array.isArray(agentsBody),
        amaStatus: ama.status,
        amaBody,
      };
    });

    expect(result.listStatus).toBe(200);
    expect(result.listIsArray).toBe(true);
    expect(result.amaStatus).toBe(401);
    expect(result.amaBody).toEqual({
      error: {
        code: "AMA_USER_AUTH_REQUIRED",
        message: "Sign in again to authorize Agent Kanban to use AMA.",
      },
    });
  });
});

function d1DatabasePath(): string {
  const database = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!database) throw new Error("Local D1 database not found");
  return join(d1Dir, database);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
