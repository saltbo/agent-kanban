// @vitest-environment node

import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestAgent, createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

vi.mock("../apps/web/server/realmrootMachineAuth", () => ({
  createAmaMachineAuthorizer: () => async () => ({ accessToken: "test.jwt.token", dpopProof: "test-dpop-proof" }),
  invalidateAmaMachineToken: vi.fn(),
}));

let db: D1Database;
let mf: Miniflare;

function env() {
  return {
    ...createTestEnv(),
    DB: db,
    AMA_ORIGIN: "https://ama.test",
    AMA_MACHINE_CLIENT_ID: "ak-app",
    AMA_MACHINE_CLIENT_SECRET: "ak-secret",
    AMA_MACHINE_SCOPES: "ama:read ama:write",
    AMA_DPOP_PRIVATE_JWK: "{}",
  } as any;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return input instanceof Request ? input.method : (init?.method ?? "GET");
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, any>> {
  const raw = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
  return JSON.parse(raw);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function amaHttpTrigger(id: string, projectId: string) {
  const now = "2026-07-20T00:00:00.000Z";
  return {
    metadata: {
      uid: id,
      projectId,
      name: id,
      description: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      source: { type: "http", concurrency: { mode: "serial" } },
      suspend: false,
      template: {
        metadata: { labels: {}, annotations: {} },
        spec: {
          agentId: "ama_agent_maintainer",
          environmentId: null,
          runtime: "codex",
          promptTemplate: "",
          env: {},
          envFrom: [],
          volumes: [],
          volumeMounts: [],
        },
      },
    },
    status: { lastDispatchedAt: null, lastRunId: null },
  };
}

async function seedMaintainer(input: { serialized?: boolean; status?: "active" | "paused"; ownerId?: string }) {
  const ownerId = input.ownerId ?? `maintainer-concurrency-${randomUUID()}`;
  const projectId = `project_${randomUUID()}`;
  const triggerId = `http_${randomUUID()}`;
  await seedUser(db, ownerId, `${ownerId}@test.com`);
  await db
    .prepare(
      `INSERT INTO ama_owner_integrations (tenant_id, ama_project_id, session_secret_vault_id, metadata)
       VALUES (?, ?, 'vault_concurrency', '{}')`,
    )
    .bind(ownerId, projectId)
    .run();

  const { createBoard } = await import("../apps/web/server/boardRepo");
  const { createBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
  const board = await createBoard(db, ownerId, `maintainer-concurrency-${randomUUID()}`, "dev");
  const agent = await createTestAgent(db, ownerId, {
    name: "Concurrency maintainer",
    username: `concurrency-maintainer-${randomUUID()}`,
    runtime: "codex",
    kind: "leader",
    role: "board-maintainer",
  });
  const maintainer = await createBoardMaintainer(db, ownerId, {
    boardId: board.id,
    agentId: agent.id,
    amaScheduleId: `schedule_${randomUUID()}`,
    amaHttpTriggerId: triggerId,
    amaHttpTriggerSerialized: input.serialized ?? false,
    amaMemoryStoreId: `memory_${randomUUID()}`,
    prompt: "",
    intervalSeconds: 3600,
    heartbeatEnabled: true,
    status: input.status ?? "active",
  });
  return { ownerId, projectId, triggerId, maintainer };
}

beforeAll(async () => {
  ({ db, mf } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.prepare("UPDATE board_maintainers SET ama_http_trigger_serialized = 1").run();
});

describe("maintainer HTTP trigger concurrency migration", () => {
  it("PATCHes a legacy trigger to serial before marking the maintainer migrated", async () => {
    const { ensureMaintainerHttpTriggerSerial } = await import("../apps/web/server/maintainerTriggerConcurrency");
    const { getBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
    const seeded = await seedMaintainer({ serialized: false });
    const requests: Record<string, any>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(requestUrl(input)).toBe(`https://ama.test/api/v1/triggers/${seeded.triggerId}`);
        expect(requestMethod(input, init)).toBe("PATCH");
        const body = await requestBody(input, init);
        requests.push(body);
        return jsonResponse(amaHttpTrigger(seeded.triggerId, seeded.projectId));
      }),
    );

    await ensureMaintainerHttpTriggerSerial(db, env(), seeded.maintainer);

    expect(requests).toEqual([{ spec: { source: { type: "http", concurrency: { mode: "serial" } } } }]);
    await expect(getBoardMaintainer(db, seeded.ownerId, seeded.maintainer.board_id, seeded.maintainer.id)).resolves.toMatchObject({
      ama_http_trigger_serialized: true,
    });
  });

  it("does not mark the maintainer migrated when AMA rejects the PATCH", async () => {
    const { ensureMaintainerHttpTriggerSerial } = await import("../apps/web/server/maintainerTriggerConcurrency");
    const { getBoardMaintainer } = await import("../apps/web/server/boardMaintainerRepo");
    const seeded = await seedMaintainer({ serialized: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)),
    );

    await expect(ensureMaintainerHttpTriggerSerial(db, env(), seeded.maintainer)).rejects.toThrow("AMA update HTTP trigger failed");
    await expect(getBoardMaintainer(db, seeded.ownerId, seeded.maintainer.board_id, seeded.maintainer.id)).resolves.toMatchObject({
      ama_http_trigger_serialized: false,
    });
  });

  it("skips AMA when the maintainer is already migrated", async () => {
    const { ensureMaintainerHttpTriggerSerial } = await import("../apps/web/server/maintainerTriggerConcurrency");
    const seeded = await seedMaintainer({ serialized: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await ensureMaintainerHttpTriggerSerial(db, env(), seeded.maintainer);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("backfills a bounded batch and leaves the remainder for the next cron tick", async () => {
    const { backfillMaintainerHttpTriggerConcurrency } = await import("../apps/web/server/maintainerTriggerConcurrency");
    await seedMaintainer({ serialized: false });
    await seedMaintainer({ serialized: false });
    await seedMaintainer({ serialized: false });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const triggerId = requestUrl(input).split("/").at(-1)!;
      return jsonResponse(amaHttpTrigger(triggerId, "project_batch"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backfillMaintainerHttpTriggerConcurrency(db, env(), 2)).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM board_maintainers WHERE ama_http_trigger_serialized = 0 AND status != 'archived'")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  it("continues after one failed backfill and retries it on the next cron tick", async () => {
    const { backfillMaintainerHttpTriggerConcurrency } = await import("../apps/web/server/maintainerTriggerConcurrency");
    const first = await seedMaintainer({ serialized: false });
    const second = await seedMaintainer({ serialized: false });
    let failTriggerId: string | null = first.triggerId;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const triggerId = requestUrl(input).split("/").at(-1)!;
        if (triggerId === failTriggerId) return jsonResponse({ error: "temporary" }, 503);
        return jsonResponse(amaHttpTrigger(triggerId, second.projectId));
      }),
    );

    await expect(backfillMaintainerHttpTriggerConcurrency(db, env(), 25)).resolves.toBe(1);
    const failedRow = await db
      .prepare("SELECT ama_http_trigger_serialized FROM board_maintainers WHERE id = ?")
      .bind(first.maintainer.id)
      .first<{ ama_http_trigger_serialized: number }>();
    expect(failedRow?.ama_http_trigger_serialized).toBe(0);

    failTriggerId = null;
    await expect(backfillMaintainerHttpTriggerConcurrency(db, env(), 25)).resolves.toBe(1);
    const retriedRow = await db
      .prepare("SELECT ama_http_trigger_serialized FROM board_maintainers WHERE id = ?")
      .bind(first.maintainer.id)
      .first<{ ama_http_trigger_serialized: number }>();
    expect(retriedRow?.ama_http_trigger_serialized).toBe(1);
  });

  it("rotates a fully failed batch so a later maintainer can advance on the next cron tick", async () => {
    const { backfillMaintainerHttpTriggerConcurrency } = await import("../apps/web/server/maintainerTriggerConcurrency");
    const firstFailure = await seedMaintainer({ serialized: false });
    const secondFailure = await seedMaintainer({ serialized: false });
    const laterSuccess = await seedMaintainer({ serialized: false });
    await db.prepare("UPDATE board_maintainers SET created_at = ? WHERE id = ?").bind("2026-07-20T00:00:00.000Z", firstFailure.maintainer.id).run();
    await db.prepare("UPDATE board_maintainers SET created_at = ? WHERE id = ?").bind("2026-07-20T00:00:01.000Z", secondFailure.maintainer.id).run();
    await db.prepare("UPDATE board_maintainers SET created_at = ? WHERE id = ?").bind("2026-07-20T00:00:02.000Z", laterSuccess.maintainer.id).run();

    const failingTriggerIds = new Set([firstFailure.triggerId, secondFailure.triggerId]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const triggerId = requestUrl(input).split("/").at(-1)!;
      if (failingTriggerIds.has(triggerId)) return jsonResponse({ error: "permanent" }, 503);
      return jsonResponse(amaHttpTrigger(triggerId, laterSuccess.projectId));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(backfillMaintainerHttpTriggerConcurrency(db, env(), 2)).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatch = await db
      .prepare(
        `SELECT id, ama_http_trigger_serialization_attempted_at
         FROM board_maintainers
         WHERE id IN (?, ?)
         ORDER BY id`,
      )
      .bind(firstFailure.maintainer.id, secondFailure.maintainer.id)
      .all<{ id: string; ama_http_trigger_serialization_attempted_at: string | null }>();
    expect(firstBatch.results).toHaveLength(2);
    expect(firstBatch.results.every((row) => row.ama_http_trigger_serialization_attempted_at !== null)).toBe(true);

    await expect(backfillMaintainerHttpTriggerConcurrency(db, env(), 2)).resolves.toBe(1);
    const laterRow = await db
      .prepare("SELECT ama_http_trigger_serialized FROM board_maintainers WHERE id = ?")
      .bind(laterSuccess.maintainer.id)
      .first<{ ama_http_trigger_serialized: number }>();
    expect(laterRow?.ama_http_trigger_serialized).toBe(1);
  });
});
