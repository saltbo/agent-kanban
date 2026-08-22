// spec: Task chat runtime events
// seed: tests/seed.spec.ts

import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { seedRealmrootAgent, signUpAndGetBoard } from "../helpers/auth";

const AMA_SESSION_ID = "session-historical-e2e";
const AMA_PROJECT_ID = "project-historical_e2e";
const CURRENT_AMA_PROJECT_ID = "project-current-e2e";
const FAKE_AMA_ORIGIN = "http://127.0.0.1:6266";
const DEFAULT_E2E_ENCRYPTION_KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=";
const d1Dir = join(process.cwd(), "apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject");

test.describe("Task chat runtime events", () => {
  test("opens a historical task session through the real Cookie and Origin WebSocket proxy", async ({ page, request }) => {
    await signUpAndGetBoard(page, `chatpagination_${Date.now()}@example.com`);
    const boardId = page.url().split("/boards/")[1];
    const agentUsername = `chat-pg-agent-${Date.now()}`;
    const agentId = await seedRealmrootAgent(page, { name: agentUsername, username: agentUsername });
    const taskId = `chatpg${Date.now()}`;
    const database = d1DatabasePath();
    const tenantId = sqliteScalar(database, `SELECT owner_id FROM agents WHERE id = '${sqlString(agentId)}';`);
    const subjectId = sqliteScalar(database, `SELECT subject_id FROM realmroot_web_sessions WHERE tenant_id = '${sqlString(tenantId)}' LIMIT 1;`);
    const access = await encryptForE2e("e2e-ama-access");
    const refresh = await encryptForE2e("e2e-ama-refresh");
    const nowIso = new Date().toISOString();
    const metadataJson = JSON.stringify({ annotations: { "ama.sessionId": AMA_SESSION_ID, "ama.projectId": AMA_PROJECT_ID } });
    execFileSync("sqlite3", [
      "-cmd",
      ".timeout 10000",
      database,
      `BEGIN IMMEDIATE;
       INSERT OR REPLACE INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
       VALUES ('${sqlString(tenantId)}', '${CURRENT_AMA_PROJECT_ID}', NULL, '{}');
       INSERT OR REPLACE INTO realmroot_user_ama_grants
         (tenant_id, subject_id, refresh_token_ciphertext, refresh_token_nonce,
          access_token_ciphertext, access_token_nonce, access_token_expires_at)
       VALUES (
         '${sqlString(tenantId)}', '${sqlString(subjectId)}', '${refresh.ciphertext}', '${refresh.nonce}',
         '${access.ciphertext}', '${access.nonce}', '${new Date(Date.now() + 60 * 60 * 1000).toISOString()}'
       );
       INSERT INTO tasks (id, board_id, seq, status, title, assigned_to, metadata, position, created_at, updated_at)
       VALUES ('${taskId}', '${boardId}', 999999, 'in_progress', 'chat-pagination', '${agentId}', '${sqlString(metadataJson)}', 0, '${nowIso}', '${nowIso}');
       COMMIT;`,
    ]);
    await request.delete(`${FAKE_AMA_ORIGIN}/__requests`);

    await page.goto(`/boards/${boardId}`);
    await expect(page.locator(".hidden.md\\:grid")).toBeVisible();
    const taskCard = page.locator(`[data-task-id="${taskId}"]`);
    await expect(taskCard).toBeVisible();
    await taskCard.getByText("chat-pagination").click();
    const detailSheet = page.locator('[data-slot="sheet-content"]').first();
    await expect(detailSheet).toBeVisible();

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const socketUrls = new Map<string, string>();
    cdp.on("Network.webSocketCreated", (event) => socketUrls.set(event.requestId, event.url));
    const handshake = new Promise<{ url: string; headers: Record<string, string> }>((resolve) => {
      cdp.on("Network.webSocketWillSendHandshakeRequest", (event) => {
        const url = socketUrls.get(event.requestId);
        if (url?.includes(`/api/ama/sessions/${AMA_SESSION_ID}/socket`)) resolve({ url, headers: event.request.headers });
      });
    });
    const handshakeResult = new Promise<{ status?: number; error?: string }>((resolve) => {
      cdp.on("Network.webSocketHandshakeResponseReceived", (event) => {
        if (socketUrls.get(event.requestId)?.includes(`/api/ama/sessions/${AMA_SESSION_ID}/socket`)) {
          resolve({ status: event.response.status });
        }
      });
      cdp.on("Network.webSocketFrameError", (event) => {
        if (socketUrls.get(event.requestId)?.includes(`/api/ama/sessions/${AMA_SESSION_ID}/socket`)) {
          resolve({ error: event.errorMessage });
        }
      });
    });
    const sessionWsRequest = page.waitForRequest((req) => req.url().includes(`/tasks/${taskId}/session/ws`), { timeout: 20_000 });
    const agentButton = detailSheet.locator("button[type='button']").filter({ hasText: /chat-pg-agent/ });
    await expect(agentButton).toBeVisible();
    await agentButton.click();
    await sessionWsRequest;
    const chatSheet = page.locator('[data-slot="sheet-content"]').nth(1);
    await expect(chatSheet).toBeVisible();
    await expect(chatSheet.getByText("Loading runtime history...")).toBeVisible();

    const browserHandshake = await handshake;
    const socketUrl = new URL(browserHandshake.url);
    expect(socketUrl.pathname).toBe(`/api/ama/sessions/${AMA_SESSION_ID}/socket`);
    expect(socketUrl.searchParams.get("projectId")).toBe(AMA_PROJECT_ID);
    expect(socketUrl.searchParams.has("access_token")).toBe(false);
    expect(browserHandshake.headers.Origin).toBe(new URL(page.url()).origin);
    expect(await handshakeResult).toEqual({ status: 101 });
    const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === "ak_session");
    expect(sessionCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });

    await expect
      .poll(async () => fakeAmaWebSocketMessages(request))
      .toEqual([
        { type: "backfill", requestId: "backfill-1", limit: 200 },
        { type: "backfill", requestId: "backfill-2", limit: 200, cursor: 1 },
      ]);
    await expect(chatSheet.getByText("Loading runtime history...")).toBeHidden();
    await expect(chatSheet.getByText("Agent", { exact: true })).toBeVisible();
    await expect.poll(async () => fakeAmaRequests(request)).toHaveLength(2);
    expect(await fakeAmaRequests(request)).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          pathname: `/api/v1/sessions/${AMA_SESSION_ID}`,
          authorization: "Bearer e2e-ama-access",
          projectId: AMA_PROJECT_ID,
        },
        {
          method: "GET",
          pathname: `/api/v1/sessions/${AMA_SESSION_ID}/socket`,
          authorization: "Bearer e2e-ama-access",
          projectId: AMA_PROJECT_ID,
        },
      ]),
    );

    await chatSheet.getByRole("button", { name: "✕" }).click();
    await expect(chatSheet).toBeHidden();
    await request.delete(`${FAKE_AMA_ORIGIN}/__requests`);
    const rejectedSockets = await page.evaluate(
      async ({ historicalProjectId }) => {
        async function rejected(path: string): Promise<boolean> {
          return await new Promise<boolean>((resolve) => {
            const socket = new WebSocket(`${location.origin.replace(/^http/, "ws")}${path}`);
            socket.onopen = () => {
              socket.close();
              resolve(false);
            };
            socket.onerror = () => resolve(true);
          });
        }
        return await Promise.all([
          rejected(`/api/ama/sessions/session-historical-e2e/socket?projectId=project-foreign-e2e`),
          rejected(`/api/ama/sessions/session-foreign-e2e/socket?projectId=${encodeURIComponent(historicalProjectId)}`),
        ]);
      },
      { historicalProjectId: AMA_PROJECT_ID },
    );
    expect(rejectedSockets).toEqual([true, true]);
    await expect.poll(async () => fakeAmaRequests(request)).toHaveLength(2);
    expect(await fakeAmaRequests(request)).toEqual(
      expect.arrayContaining([
        {
          method: "GET",
          pathname: `/api/v1/sessions/${AMA_SESSION_ID}`,
          authorization: "Bearer e2e-ama-access",
          projectId: "project-foreign-e2e",
        },
        {
          method: "GET",
          pathname: "/api/v1/sessions/session-foreign-e2e",
          authorization: "Bearer e2e-ama-access",
          projectId: AMA_PROJECT_ID,
        },
      ]),
    );
  });
});

async function fakeAmaRequests(request: import("@playwright/test").APIRequestContext) {
  return (await (await request.get(`${FAKE_AMA_ORIGIN}/__requests`)).json()) as Array<{
    method: string;
    pathname: string;
    authorization: string | null;
    projectId: string | null;
  }>;
}

async function fakeAmaWebSocketMessages(request: import("@playwright/test").APIRequestContext) {
  return (await (await request.get(`${FAKE_AMA_ORIGIN}/__websocket-messages`)).json()) as Array<Record<string, unknown>>;
}

async function encryptForE2e(value: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await webcrypto.subtle.importKey("raw", Buffer.from(DEFAULT_E2E_ENCRYPTION_KEY, "base64"), "AES-GCM", false, ["encrypt"]);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(value));
  return { ciphertext: base64Url(Buffer.from(ciphertext)), nonce: base64Url(Buffer.from(nonce)) };
}

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function sqliteScalar(database: string, query: string): string {
  const value = execFileSync("sqlite3", [database, query]).toString().trim();
  if (!value) throw new Error(`SQLite fixture query returned no value: ${query}`);
  return value;
}

function d1DatabasePath(): string {
  const db = readdirSync(d1Dir).find((file) => file.endsWith(".sqlite") && file !== "metadata.sqlite");
  if (!db) throw new Error("Local D1 database not found");
  return join(d1Dir, db);
}

function sqlString(value: string): string {
  return value.replace(/'/g, "''");
}
