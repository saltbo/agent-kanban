// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import { createRepository } from "../../../server/adapters/d1/repositoryRepo";
import { createTask } from "../../../server/adapters/d1/taskRepo";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "../../helpers/db";

const ownerId = "tenant-removed-routes";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let db: D1Database;
let env: Env;

beforeEach(async () => {
  ({ mf, db } = await setupMiniflare());
  env = { ...createTestEnv(), DB: db } as Env;
  await seedUser(db, ownerId, "removed-routes@example.test");
});

afterEach(async () => mf.dispose());

describe("removed internal HTTP routes", () => {
  it("rejects the removed Task messages route at the API boundary", async () => {
    const board = await createBoard(db, ownerId, "No messages", "ops");
    const task = await createTask(db, ownerId, { title: "Notes only", board_id: board.id });
    const session = await createTestWebSession(db, ownerId);

    const response = await api.fetch(
      new Request(`http://localhost:8788/api/tasks/${task.id}/messages`, { headers: { cookie: session.cookie } }),
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN", message: "Operation is not available to this principal" } });
  });

  it("rejects the removed repository GitHub token action route at the API boundary", async () => {
    const repository = await createRepository(db, ownerId, {
      name: `removed-token-${randomUUID()}`,
      url: "https://github.com/example/repository",
    });
    const session = await createTestWebSession(db, ownerId);

    const response = await api.fetch(
      new Request(`http://localhost:8788/api/repositories/${repository.id}/github-token`, {
        method: "POST",
        headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
      }),
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "FORBIDDEN", message: "Operation is not available to this principal" } });
  });
});
