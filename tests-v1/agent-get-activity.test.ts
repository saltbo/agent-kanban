// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestAgent, seedUser, setupMiniflare } from "./helpers/db";

let db: D1Database;
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];

function tracePreparedSql(database: D1Database): { database: D1Database; queries: string[] } {
  const queries: string[] = [];
  const traced = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          queries.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { database: traced, queries };
}

beforeAll(async () => {
  ({ db, mf } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("getAgent activity", () => {
  it("combines task counts and indexed local plus AMA session usage", async () => {
    const ownerId = `agent-activity-owner-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(db, ownerId, `agent-activity-${randomUUID()}`, "ops");
    const agent = await createTestAgent(db, ownerId, {
      username: `agent-activity-${randomUUID()}`,
      runtime: "claude",
    });
    const machine = await upsertMachine(db, ownerId, {
      name: "activity-machine",
      os: "test",
      version: "1.0.0",
      runtimes: [],
      device_id: `activity-machine-${randomUUID()}`,
    });

    const statuses = ["todo", "todo", "in_progress", "in_review", "done", "cancelled"] as const;
    for (const [index, status] of statuses.entries()) {
      const task = await createTask(db, ownerId, {
        title: `activity task ${index}`,
        board_id: board.id,
        assigned_to: agent.id,
        skipRuntimeAvailability: true,
      });
      if (status !== "todo") {
        await db.prepare("UPDATE tasks SET status = ? WHERE id = ?").bind(status, task.id).run();
      }
    }

    await db
      .prepare(
        `INSERT INTO agent_sessions (
          id, agent_id, machine_id, status, public_key, delegation_proof,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        ) VALUES (?, ?, ?, 'closed', 'local-key', 'local-proof', 101, 11, 7, 3, 500)`,
      )
      .bind(`local-session-${randomUUID()}`, agent.id, machine.id)
      .run();
    await db
      .prepare(
        `INSERT INTO ama_agent_sessions (
          id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        ) VALUES (?, ?, ?, ?, 'active', 'ama-key', 'ama-proof', 211, 19, 13, 5, 900)`,
      )
      .bind(`ama-session-${randomUUID()}`, ownerId, agent.id, `remote-session-${randomUUID()}`)
      .run();

    const trace = tracePreparedSql(db);
    const activity = await getAgent(trace.database, agent.id, ownerId);

    expect(activity).not.toBeNull();
    expect(activity!.status.tasks).toEqual({
      todo: 2,
      in_progress: 1,
      in_review: 1,
      done: 1,
      cancelled: 1,
    });
    expect(activity).toMatchObject({
      input_tokens: 312,
      output_tokens: 30,
      cache_read_tokens: 20,
      cache_creation_tokens: 8,
      cost_micro_usd: 1400,
    });

    const usageQuery = trace.queries.find((query) => /\bFROM\s+agent_sessions\b[\s\S]*\bFROM\s+ama_agent_sessions\b/i.test(query));
    expect(usageQuery).toBeDefined();
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${usageQuery}`).bind(agent.id, agent.id).all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    expect(details).toMatch(/\bSEARCH agent_sessions\b/i);
    expect(details).toMatch(/\bSEARCH ama_agent_sessions\b/i);
    expect(details).not.toMatch(/\bSCAN (?:agent_sessions|ama_agent_sessions)\b/i);
  });

  it("lists each agent with one combined tenant-scoped usage aggregation", async () => {
    const ownerId = `agent-list-activity-owner-${randomUUID()}`;
    await seedUser(db, ownerId, `${ownerId}@test.local`);
    const { listAgents } = await import("../apps/web/server/agentRepo");
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const firstAgent = await createTestAgent(db, ownerId, {
      username: `agent-list-first-${randomUUID()}`,
      runtime: "claude",
    });
    const secondAgent = await createTestAgent(db, ownerId, {
      username: `agent-list-second-${randomUUID()}`,
      runtime: "codex",
    });
    const machine = await upsertMachine(db, ownerId, {
      name: "list-activity-machine",
      os: "test",
      version: "1.0.0",
      runtimes: [],
      device_id: `list-activity-machine-${randomUUID()}`,
    });

    await db.batch([
      db
        .prepare(
          `INSERT INTO agent_sessions (
            id, agent_id, machine_id, status, public_key, delegation_proof,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
          ) VALUES (?, ?, ?, 'closed', 'first-local-key', 'first-local-proof', 10, 11, 12, 13, 14)`,
        )
        .bind(`first-local-${randomUUID()}`, firstAgent.id, machine.id),
      db
        .prepare(
          `INSERT INTO ama_agent_sessions (
            id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
          ) VALUES (?, ?, ?, ?, 'closed', 'first-ama-key', 'first-ama-proof', 20, 21, 22, 23, 24)`,
        )
        .bind(`first-ama-${randomUUID()}`, ownerId, firstAgent.id, `first-remote-${randomUUID()}`),
      db
        .prepare(
          `INSERT INTO agent_sessions (
            id, agent_id, machine_id, status, public_key, delegation_proof,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
          ) VALUES (?, ?, ?, 'closed', 'second-local-key', 'second-local-proof', 100, 110, 120, 130, 140)`,
        )
        .bind(`second-local-${randomUUID()}`, secondAgent.id, machine.id),
      db
        .prepare(
          `INSERT INTO ama_agent_sessions (
            id, owner_id, agent_id, ama_session_id, status, public_key, delegation_proof,
            input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
          ) VALUES (?, ?, ?, ?, 'closed', 'second-ama-key', 'second-ama-proof', 200, 210, 220, 230, 240)`,
        )
        .bind(`second-ama-${randomUUID()}`, ownerId, secondAgent.id, `second-remote-${randomUUID()}`),
    ]);

    const trace = tracePreparedSql(db);
    const agents = await listAgents(trace.database, ownerId);

    expect(agents.find((agent) => agent.id === firstAgent.id)).toMatchObject({
      input_tokens: 30,
      output_tokens: 32,
      cache_read_tokens: 34,
      cache_creation_tokens: 36,
      cost_micro_usd: 38,
    });
    expect(agents.find((agent) => agent.id === secondAgent.id)).toMatchObject({
      input_tokens: 300,
      output_tokens: 320,
      cache_read_tokens: 340,
      cache_creation_tokens: 360,
      cost_micro_usd: 380,
    });

    expect(trace.queries).toHaveLength(1);
    const [query] = trace.queries;
    expect(query.match(/\bFROM\s+agent_sessions\b/gi)).toHaveLength(1);
    expect(query.match(/\bFROM\s+ama_agent_sessions\b/gi)).toHaveLength(1);
    expect(query.match(/\bUNION\s+ALL\b/gi)).toHaveLength(1);
    expect(query).not.toMatch(/\bSELECT\s+SUM\(s\./i);
  });
});
