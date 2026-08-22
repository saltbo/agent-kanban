// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations, createTestAgent, createTestSubagent } from "./helpers/db";

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");

let db: D1Database;
let mf: Miniflare;

async function applyMigrations(db: D1Database) {
  const files = [
    "0001_initial.sql",
    "0002_rename_task_logs_to_task_notes.sql",
    "0003_agent_kind.sql",
    "0004_rename_task_notes_to_task_actions.sql",
    "0005_agent_runtime_required.sql",
    "0006_add_device_id.sql",
    "0007_task_seq.sql",
    "0010_board_type.sql",
    "0011_task_scheduled_at.sql",
    "0012_gpg_keys.sql",
    "0013_agent_identity.sql",
    "0014_agent_mailbox_token.sql",
    "0015_username_global_unique.sql",
    "0016_task_actions_session_id.sql",
    "0017_unique_leader_per_runtime.sql",
    "0018_agent_subagents.sql",
    "0019_agent_versions.sql",
    "0021_subagents.sql",
    "0022_ama_runtime_integration.sql",
    "0025_machine_hosting.sql",
    "0026_agent_ama_agent_id.sql",
    "0028_board_maintainer_triggers_memory.sql",
    "0030_agent_taints.sql",
    "0031_drop_board_maintainer_name.sql",
    "0032_board_maintainer_api_key.sql",
    "0033_board_maintainer_heartbeat_enabled.sql",
    "0034_task_assignee_status_index.sql",
    "0035_board_maintainer_vault.sql",
    "0036_backfill_ama_session_secret_refs.sql",
    "0037_unique_latest_leader_per_runtime.sql",
    "0038_board_maintainer_http_trigger_serial.sql",
    "0039_realmroot_native.sql",
    "0040_ama_resource_initialization_claims.sql",
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    for (const stmt of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.prepare(stmt).run();
    }
  }
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "test-db" },
  });
  db = await mf.getD1Database("DB");
  await applyAllMigrations(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("agent JSON field parsing (skills, handoff_to, subagents)", () => {
  const ownerId = "user-json-agent";
  let agentId: string;
  let subagentId: string;

  it("createAgent returns skills, handoff_to, and subagents as arrays", async () => {
    const subagent = await createTestSubagent(db, ownerId, {
      name: "JSON Subagent",
      username: "json-subagent",
    });
    subagentId = subagent.id;

    const agent = await createTestAgent(db, ownerId, {
      name: "Test Agent",
      username: "test-agent",
      runtime: "claude",
      skills: ["trailofbits/skills@differential-review", "obra/superpowers@verification-before-completion"],
      handoff_to: ["quality-goalkeeper", "enduser"],
      subagents: [subagentId],
    });
    agentId = agent.id;

    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toEqual(["trailofbits/skills@differential-review", "obra/superpowers@verification-before-completion"]);
    expect(Array.isArray(agent.handoff_to)).toBe(true);
    expect(agent.handoff_to).toEqual(["quality-goalkeeper", "enduser"]);
    expect(Array.isArray(agent.subagents)).toBe(true);
    expect(agent.subagents).toEqual([subagentId]);
  });

  it("createAgent with null skills/handoff_to/subagents returns null", async () => {
    const agent = await createTestAgent(db, ownerId, { name: "Bare Agent", username: "bare-agent", runtime: "claude" });

    expect(agent.skills).toBeNull();
    expect(agent.handoff_to).toBeNull();
    expect(agent.subagents).toBeNull();
  });

  it("listAgents returns parsed arrays", async () => {
    const { listAgents } = await import("../apps/web/server/agentRepo");
    const agents = await listAgents(db, ownerId);
    const agent = agents.find((a) => a.id === agentId)!;

    expect(Array.isArray(agent.skills)).toBe(true);
    expect(agent.skills).toEqual(["trailofbits/skills@differential-review", "obra/superpowers@verification-before-completion"]);
    expect(Array.isArray(agent.handoff_to)).toBe(true);
    expect(agent.handoff_to).toEqual(["quality-goalkeeper", "enduser"]);
    expect(Array.isArray(agent.subagents)).toBe(true);
    expect(agent.subagents).toEqual([subagentId]);
  });

  it("listAgents returns email derived from username", async () => {
    const { listAgents } = await import("../apps/web/server/agentRepo");
    const agents = await listAgents(db, ownerId);
    const agent = agents.find((a) => a.id === agentId)!;

    expect(agent.username).toBe("test-agent");
    expect(agent.email).toBe("test-agent@mails.agent-kanban.dev");
  });

  it("getAgent returns parsed arrays", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(db, agentId, ownerId);

    expect(agent).toBeTruthy();
    expect(Array.isArray(agent!.skills)).toBe(true);
    expect(agent!.skills).toEqual(["trailofbits/skills@differential-review", "obra/superpowers@verification-before-completion"]);
    expect(Array.isArray(agent!.handoff_to)).toBe(true);
    expect(Array.isArray(agent!.subagents)).toBe(true);
    expect(agent!.subagents).toEqual([subagentId]);
  });

  it("getAgent returns email derived from username", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(db, agentId, ownerId);

    expect(agent).toBeTruthy();
    expect(agent!.username).toBe("test-agent");
    expect(agent!.email).toBe("test-agent@mails.agent-kanban.dev");
  });

  it("updateAgent accepts arrays and returns parsed arrays", async () => {
    const { updateAgent } = await import("../apps/web/server/agentRepo");
    await db.prepare("UPDATE agents SET mailbox_token = ? WHERE id = ?").bind("mailbox-secret", agentId).run();

    const agent = await updateAgent(db, agentId, {
      skills: ["new/skill@code-review"],
      handoff_to: ["enduser"],
      subagents: [subagentId],
    });

    expect(agent).toBeTruthy();
    expect(Array.isArray(agent!.skills)).toBe(true);
    expect(agent!.skills).toEqual(["new/skill@code-review"]);
    expect(agent!.handoff_to).toEqual(["enduser"]);
    expect(agent!.subagents).toEqual([subagentId]);
    expect(agent).not.toHaveProperty("private_key");
    expect(agent).not.toHaveProperty("mailbox_token");
  });

  it("updateAgent does not report ignored update fields", async () => {
    const { getAgent, updateAgent } = await import("../apps/web/server/agentRepo");
    const agent = await updateAgent(db, agentId, { name: "Ignored Field Agent", kind: "leader" } as any);

    expect(agent).toBeTruthy();
    expect(agent!.name).toBe("Ignored Field Agent");
    expect(agent!.kind).toBe("worker");

    const persisted = await getAgent(db, agentId, ownerId);
    expect(persisted!.kind).toBe("worker");
  });

  it("updated values persist through getAgent", async () => {
    const { getAgent } = await import("../apps/web/server/agentRepo");
    const agent = await getAgent(db, agentId, ownerId);

    expect(agent!.skills).toEqual(["new/skill@code-review"]);
    expect(agent!.handoff_to).toEqual(["enduser"]);
    expect(agent!.subagents).toEqual([subagentId]);
  });
});
