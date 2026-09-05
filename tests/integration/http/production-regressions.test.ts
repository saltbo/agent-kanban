// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard, updateBoard } from "../../../server/adapters/d1/boardRepo";
import { addTaskAction, createTask } from "../../../server/adapters/d1/taskRepo";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const owner = "production-regression-owner";
const origin = "https://ak.regression.test";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;
let env: Env;
let session: Awaited<ReturnType<typeof createTestWebSession>>;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  await seedUser(db, owner, "regression@example.test");
  session = await createTestWebSession(db, owner);
  env = { ...createTestEnv(), DB: db, AK_PUBLIC_ORIGIN: origin } as Env;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mf.dispose();
});

function request(method: string, path: string, body?: unknown, raw = false): Promise<Response> {
  return api.fetch(
    new Request(`${origin}/api${path}`, {
      method,
      headers: {
        cookie: session.cookie,
        "x-csrf-token": session.csrfToken,
        "API-Version": "2026-08-29",
        "Content-Type": method === "PATCH" && path.startsWith("/tasks/") ? "application/merge-patch+json" : "application/json",
        ...(method === "POST" ? { "Idempotency-Key": JSON.stringify(randomUUID()) } : {}),
      },
      body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body),
    }),
    env,
  );
}

async function expectRejected(response: Response): Promise<void> {
  expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
}

describe("production regression HTTP boundaries", () => {
  it("[spec: resource-server/generic-operations] protects strong Task validators against intermediary transformation", async () => {
    const board = await createBoard(db, owner, "Strong validators", "ops");
    const created = await request("POST", "/tasks", { title: "Versioned task", boardId: board.id });
    expect(created.status).toBe(201);
    const task = (await created.clone().json()) as { id: string };
    const read = await request("GET", `/tasks/${task.id}`);
    const changed = await request("PATCH", `/tasks/${task.id}`, { description: "Updated" });
    for (const response of [created, read, changed]) {
      expect(response.headers.get("etag")).toMatch(/^"[^" ]+"$/);
      expect(response.headers.get("cache-control")?.split(/,\s*/)).toEqual(expect.arrayContaining(["private", "no-cache", "no-transform"]));
    }
  });

  it.each(["dependsOn", "createdFrom"] as const)(
    "[spec: tasks/structured-fields] rejects cross-Board %s at Task creation without durable changes",
    async (field) => {
      const local = await createBoard(db, owner, "Local", "ops");
      const other = await createBoard(db, owner, "Other", "ops");
      const foreign = await createTask(db, owner, { title: "Same tenant other Board", board_id: other.id });
      const before = (await db.prepare("SELECT id, version FROM tasks ORDER BY id").all()).results;
      await expectRejected(
        await request("POST", "/tasks", {
          title: "Invalid cross-Board relationship",
          boardId: local.id,
          [field]: field === "dependsOn" ? [foreign.id] : foreign.id,
        }),
      );
      expect((await db.prepare("SELECT id, version FROM tasks ORDER BY id").all()).results).toEqual(before);
    },
  );

  it.each(["dependsOn", "createdFrom"] as const)(
    "[spec: tasks/structured-fields] rejects cross-Board %s at Task patch without durable changes",
    async (field) => {
      const local = await createBoard(db, owner, "Local", "ops");
      const other = await createBoard(db, owner, "Other", "ops");
      const task = await createTask(db, owner, { title: "Local task", board_id: local.id });
      const foreign = await createTask(db, owner, { title: "Other task", board_id: other.id });
      const before = (await db.prepare("SELECT id, version, created_from FROM tasks ORDER BY id").all()).results;
      await expectRejected(await request("PATCH", `/tasks/${task.id}`, { [field]: field === "dependsOn" ? [foreign.id] : foreign.id }));
      expect((await db.prepare("SELECT id, version, created_from FROM tasks ORDER BY id").all()).results).toEqual(before);
      expect((await db.prepare("SELECT * FROM task_dependencies").all()).results).toEqual([]);
    },
  );

  it.each([
    ["null name", { name: null }],
    ["object name", { name: {} }],
    ["blank name", { name: "   " }],
    ["object description", { description: {} }],
    ["unknown visibility", { visibility: "bogus" }],
    ["non-array labels", { labels: "bogus" }],
    ["invalid label color", { labels: [{ name: "bug", color: 7 }] }],
    ["unknown field", { unknown: true }],
    ["malformed JSON", "{"],
  ])("[spec: boards/settings] rejects invalid Board patch %s without durable changes", async (_name, body) => {
    const board = await createBoard(db, owner, "Valid Board", "ops");
    const before = await db.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
    await expectRejected(await request("PATCH", `/boards/${board.id}`, body, typeof body === "string"));
    expect(await db.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first()).toEqual(before);
  });

  it.each([
    ["POST", "malformed JSON", "{"],
    ["POST", "invalid name", { name: {}, color: "#112233" }],
    ["POST", "unknown field", { name: "bug", color: "#112233", unknown: true }],
    ["PATCH", "malformed JSON", "{"],
    ["PATCH", "invalid color", { color: {} }],
    ["PATCH", "invalid description", { description: [] }],
    ["PATCH", "unknown field", { unknown: true }],
  ])("[spec: boards/labels] rejects invalid Board label %s %s without durable changes", async (method, _name, body) => {
    const board = await createBoard(db, owner, "Valid labels", "ops");
    await updateBoard(db, board.id, owner, { labels: [{ name: "existing", color: "#112233", description: "Original" }] });
    const before = await db.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first();
    const path = `/boards/${board.id}/labels${method === "PATCH" ? "/existing" : ""}`;
    await expectRejected(await request(method as string, path, body, typeof body === "string"));
    expect(await db.prepare("SELECT * FROM boards WHERE id = ?").bind(board.id).first()).toEqual(before);
  });

  it("[spec: repositories/manual-management] rejects duplicate canonical Repository URLs as a conflict", async () => {
    const first = await request("POST", "/repositories", { name: "Original", url: "git@example.test:owner/repo.git" });
    expect(first.status).toBe(201);
    const before = (await db.prepare("SELECT * FROM repositories").all()).results;
    const duplicate = await request("POST", "/repositories", { name: "Duplicate", url: "https://example.test/owner/repo/" });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    expect(duplicate.headers.get("content-type")).toContain("application/problem+json");
    expect((await db.prepare("SELECT * FROM repositories").all()).results).toEqual(before);
  });

  it("[spec: public-boards/live-view] closes an existing public stream when sharing is revoked before a later Note", async () => {
    const board = await createBoard(db, owner, "Revocable stream", "ops");
    const published = await updateBoard(db, board.id, owner, { visibility: "public" });
    const task = await createTask(db, owner, { title: "Stream task", board_id: board.id });
    await addTaskAction(db, task.id, "user", owner, "commented", "Initially public");
    const realSetTimeout = globalThis.setTimeout;
    let releasePoll: (() => void) | undefined;
    let ready!: () => void;
    const pollReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
      if (delay === 2000) {
        releasePoll = callback;
        ready();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const streamPath = `/api/share/${published!.share_slug}/stream`;
    const response = await api.request(streamPath, {}, env);
    const reader = response.body!.getReader();
    try {
      let initial = "";
      while (!initial.includes("Initially public")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        initial += new TextDecoder().decode(chunk.value);
      }
      await pollReady;
      await request("PATCH", `/boards/${board.id}`, { visibility: "private" });
      await addTaskAction(db, task.id, "user", owner, "commented", "Private after revocation");
      expect((await api.request(streamPath, {}, env)).status).toBe(404);
      const next = reader.read();
      releasePoll!();
      await expect(next).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await reader.cancel(new Error("Test reader closed"));
    }
  });
});
