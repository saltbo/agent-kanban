// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MachineRuntime, UsageInfo } from "@agent-kanban/shared";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations as applyAllMigrations } from "./helpers/db";

const MIGRATIONS_DIR = join(__dirname, "../apps/web/migrations");

let db: D1Database;
let mf: Miniflare;

const checkedAt = "2026-03-21T10:00:00Z";
const claudeRuntime: MachineRuntime = { name: "claude", status: "ready", checked_at: checkedAt };
const codexRuntime: MachineRuntime = { name: "codex", status: "ready", checked_at: checkedAt };

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

describe("machine usage tracking", () => {
  let machineId: string;

  it("upsertMachine stores os/version/runtimes and returns usage_info as null", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const machine = await upsertMachine(db, "user-001", {
      name: "test-machine",
      os: "darwin arm64",
      version: "1.0.0",
      runtimes: [claudeRuntime],
      device_id: "test-device-usage",
    });
    machineId = machine.id;
    expect(machine.os).toBe("darwin arm64");
    expect(machine.version).toBe("1.0.0");
    expect(machine.runtimes).toEqual([claudeRuntime]);
    expect(machine.usage_info).toBeNull();
  });

  it("heartbeat without usage_info keeps it null", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const machine = await heartbeat(db, machineId, "user-001", {});
    expect(machine.usage_info).toBeNull();
    expect(machine.status).toBe("online");
  });

  it("heartbeat with usage_info stores and returns parsed object", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const usageInfo: UsageInfo = {
      windows: [
        { runtime: "claude", label: "5-Hour", utilization: 23.5, resets_at: "2026-03-21T15:00:00Z" },
        { runtime: "claude", label: "7-Day", utilization: 8.2, resets_at: "2026-03-25T00:00:00Z" },
      ],
      updated_at: "2026-03-21T10:00:00Z",
    };
    const machine = await heartbeat(db, machineId, "user-001", { usage_info: usageInfo });

    expect(typeof machine.usage_info).toBe("object");
    expect(machine.usage_info!.windows).toHaveLength(2);
    expect(machine.usage_info!.windows[0].utilization).toBe(23.5);
    expect(machine.usage_info!.windows[1].resets_at).toBe("2026-03-25T00:00:00Z");
    expect(machine.usage_info!.updated_at).toBe("2026-03-21T10:00:00Z");
  });

  it("getMachine returns parsed usage_info and runtimes", async () => {
    const { getMachine } = await import("../apps/web/server/machineRepo");
    const machine = await getMachine(db, machineId, "user-001");

    expect(machine).toBeTruthy();
    expect(machine!.runtimes).toEqual([claudeRuntime]);
    expect(typeof machine!.usage_info).toBe("object");
    expect(machine!.usage_info!.windows[0].utilization).toBe(23.5);
  });

  it("listMachines returns parsed usage_info", async () => {
    const { listMachines } = await import("../apps/web/server/machineRepo");
    const machines = await listMachines(db, "user-001");

    expect(machines.length).toBeGreaterThan(0);
    const m = machines.find((m) => m.id === machineId)!;
    expect(typeof m.usage_info).toBe("object");
    expect(m.usage_info!.windows[0].utilization).toBe(23.5);
  });

  it("heartbeat overwrites usage_info with new data", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const newUsage: UsageInfo = {
      windows: [
        { runtime: "claude", label: "5-Hour", utilization: 75, resets_at: "2026-03-21T20:00:00Z" },
        { runtime: "claude", label: "7-Day Opus", utilization: 45, resets_at: "2026-03-28T00:00:00Z" },
      ],
      updated_at: "2026-03-21T15:00:00Z",
    };
    const machine = await heartbeat(db, machineId, "user-001", { usage_info: newUsage });

    expect(machine.usage_info!.windows).toHaveLength(2);
    expect(machine.usage_info!.windows[0].utilization).toBe(75);
    expect(machine.usage_info!.windows[1].utilization).toBe(45);
    expect(machine.usage_info!.windows[0].label).toBe("5-Hour");
  });

  it("heartbeat normalizes legacy ratio utilization values to percentages", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const machine = await heartbeat(db, machineId, "user-001", {
      usage_info: {
        windows: [{ runtime: "claude", label: "5-Hour", utilization: 0.75, resets_at: "2026-03-21T20:00:00Z" }],
        updated_at: "2026-03-21T15:00:00Z",
      },
    });

    expect(machine.usage_info!.windows[0].utilization).toBe(75);
  });

  it("getMachine normalizes legacy ratio utilization stored in the database", async () => {
    const { getMachine } = await import("../apps/web/server/machineRepo");
    await db
      .prepare("UPDATE machines SET usage_info = ? WHERE id = ?")
      .bind(
        JSON.stringify({
          windows: [{ runtime: "claude", label: "7-Day", utilization: 0.36, resets_at: "2026-03-28T00:00:00Z" }],
          updated_at: "2026-03-21T15:00:00Z",
        }),
        machineId,
      )
      .run();

    const machine = await getMachine(db, machineId, "user-001");

    expect(machine!.usage_info!.windows[0].utilization).toBe(36);
  });

  it("heartbeat with usage_info null clears stale usage data", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const machine = await heartbeat(db, machineId, "user-001", { usage_info: null });

    expect(machine.usage_info).toBeNull();
  });

  it("heartbeat updates version and runtimes", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const machine = await heartbeat(db, machineId, "user-001", {
      version: "2.0.0",
      runtimes: [claudeRuntime, codexRuntime],
    });

    expect(machine.version).toBe("2.0.0");
    expect(machine.runtimes).toEqual([claudeRuntime, codexRuntime]);
  });

  it("heartbeat updating only version preserves runtimes", async () => {
    const { updateMachine: heartbeat } = await import("../apps/web/server/machineRepo");
    const machine = await heartbeat(db, machineId, "user-001", { version: "2.1.0" });

    expect(machine.version).toBe("2.1.0");
    expect(machine.runtimes).toEqual([claudeRuntime, codexRuntime]);
  });

  it("runtimes are parsed as JSON array from DB reads", async () => {
    const { getMachine, listMachines } = await import("../apps/web/server/machineRepo");

    const single = await getMachine(db, machineId, "user-001");
    expect(Array.isArray(single!.runtimes)).toBe(true);
    expect(single!.runtimes).toEqual([claudeRuntime, codexRuntime]);

    const list = await listMachines(db, "user-001");
    const m = list.find((m) => m.id === machineId)!;
    expect(Array.isArray(m.runtimes)).toBe(true);
  });
});
