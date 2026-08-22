import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

test.describe("Cookie WebSocket origin boundary", () => {
  test("accepts the canonical browser tunnel Origin and rejects missing or cross-origin handshakes", async ({ page, request }) => {
    await signUpAndGetBoard(page, `socket_origin_${Date.now()}@example.com`);
    const agentId = await seedRealmrootAgent(page);
    const sessionId = seedAmaAgentSession(agentId);
    const canonicalOrigin = await protectedResourceOrigin(page);
    const cookie = await sessionCookie(page);
    const tunnelPath = `/api/tunnel/ws?role=browser&sessionId=${sessionId}`;

    for (const headers of [
      { upgrade: "websocket", cookie },
      { upgrade: "websocket", cookie, origin: "https://cross-origin.example.test" },
    ]) {
      const response = await request.get(tunnelPath, { headers });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "Invalid WebSocket origin", message: "Invalid WebSocket origin" } });
    }

    const canonical = await request.get(tunnelPath, {
      headers: { upgrade: "websocket", cookie, origin: canonicalOrigin },
    });
    expect(canonical.status()).toBe(101);
  });

  test("rejects missing and cross-origin AMA socket handshakes before upstream access", async ({ page, request }) => {
    await signUpAndGetBoard(page, `ama_socket_origin_${Date.now()}@example.com`);
    const cookie = await sessionCookie(page);
    const socketPath = `/api/ama/sessions/${randomUUID()}/socket`;

    for (const headers of [
      { upgrade: "websocket", cookie },
      { upgrade: "websocket", cookie, origin: "https://cross-origin.example.test" },
    ]) {
      const response = await request.get(socketPath, { headers });
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "Invalid WebSocket origin", message: "Invalid WebSocket origin" } });
    }
  });
});

async function protectedResourceOrigin(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const response = await fetch("/.well-known/oauth-protected-resource/api");
    const metadata = (await response.json()) as { resource: string };
    return new URL(metadata.resource).origin;
  });
}

async function sessionCookie(page: import("@playwright/test").Page): Promise<string> {
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "ak_session");
  if (!session) throw new Error("AK session cookie not found");
  return `${session.name}=${session.value}`;
}

function seedAmaAgentSession(agentId: string): string {
  const sessionId = randomUUID();
  const databasePath = d1DatabasePath();
  const ownerId = execFileSync("sqlite3", [databasePath, `SELECT owner_id FROM agents WHERE id = '${sqlString(agentId)}';`])
    .toString()
    .trim();
  if (!ownerId) throw new Error("Realmroot Agent owner not found");
  execFileSync("sqlite3", [
    "-cmd",
    ".timeout 10000",
    databasePath,
    `INSERT INTO ama_agent_sessions
      (id, owner_id, agent_id, ama_session_id, public_key, delegation_proof, secret_ref)
     VALUES (
       '${sessionId}',
       '${sqlString(ownerId)}',
       '${sqlString(agentId)}',
       'ama-${sessionId}',
       'e2e-public-key',
       'e2e-delegation-proof',
       'ama://vaults/e2e/credentials/${sessionId}'
     );`,
  ]);
  return sessionId;
}

function d1DatabasePath(): string {
  const database = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!database) throw new Error("Local D1 database not found");
  return join(d1Dir, database);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
