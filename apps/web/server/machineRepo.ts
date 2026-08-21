import type { AgentRuntime, Machine, MachineHosting, MachineRuntime, MachineRuntimeStatus, MachineWithAgents, UsageInfo } from "@agent-kanban/shared";
import { AGENT_RUNTIMES, MACHINE_STALE_TIMEOUT_MS, normalizeRuntime, RUNTIME_LABELS } from "@agent-kanban/shared";
import { type D1, newId, parseJsonFields } from "./db";

export interface MachineRecord extends Machine {
  ama_environment_id: string | null;
}

export interface MachineWithAgentsRecord extends MachineWithAgents {
  ama_environment_id: string | null;
}

export interface CreateMachineInfo {
  name: string;
  os: string;
  version: string;
  runtimes: MachineRuntime[];
  device_id: string;
}

export interface HeartbeatInfo {
  version?: string;
  runtimes?: MachineRuntime[];
  usage_info?: UsageInfo | null;
}

export async function upsertMachine(db: D1, ownerId: string, info: CreateMachineInfo): Promise<MachineRecord> {
  const id = newId();
  const now = new Date().toISOString();
  // device_id is the stable hardware fingerprint — never updated after creation
  await db
    .prepare(`INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?)
      ON CONFLICT(owner_id, device_id) DO UPDATE SET name = excluded.name, os = excluded.os, version = excluded.version, runtimes = excluded.runtimes`)
    .bind(id, ownerId, info.device_id, info.name, info.os, info.version, JSON.stringify(normalizeMachineRuntimes(info.runtimes, now)), now)
    .run();
  const row = await db.prepare("SELECT * FROM machines WHERE owner_id = ? AND device_id = ?").bind(ownerId, info.device_id).first<MachineRecord>();
  return parseMachine(row!);
}

export async function upsertNativeMachine(db: D1, ownerId: string, subjectId: string, info: CreateMachineInfo): Promise<MachineRecord | null> {
  const id = newId();
  const now = new Date().toISOString();
  const runtimes = JSON.stringify(normalizeMachineRuntimes(info.runtimes, now));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO realmroot_tenants (id) VALUES (?)").bind(ownerId),
    db
      .prepare(
        `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?)
         ON CONFLICT(owner_id, device_id) DO UPDATE SET
           name = excluded.name,
           os = excluded.os,
           version = excluded.version,
           runtimes = excluded.runtimes
         WHERE NOT EXISTS (
           SELECT 1 FROM realmroot_native_machine_bindings binding
           WHERE binding.tenant_id = excluded.owner_id
             AND binding.machine_id = machines.id
             AND binding.subject_id <> ?
         )`,
      )
      .bind(id, ownerId, info.device_id, info.name, info.os, info.version, runtimes, now, subjectId),
    db
      .prepare(
        `INSERT OR IGNORE INTO realmroot_native_machine_bindings (tenant_id, subject_id, machine_id)
         SELECT ?, ?, id FROM machines
         WHERE owner_id = ? AND device_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM realmroot_native_machine_bindings binding
             WHERE binding.tenant_id = ?
               AND binding.machine_id = machines.id
               AND binding.subject_id <> ?
           )`,
      )
      .bind(ownerId, subjectId, ownerId, info.device_id, ownerId, subjectId),
  ]);
  const binding = await db
    .prepare(
      `SELECT machines.* FROM machines
       JOIN realmroot_native_machine_bindings binding ON binding.machine_id = machines.id
       WHERE machines.owner_id = ? AND machines.device_id = ?
         AND binding.tenant_id = ? AND binding.subject_id = ?`,
    )
    .bind(ownerId, info.device_id, ownerId, subjectId)
    .first<MachineRecord>();
  return binding ? parseMachine(binding) : null;
}

// A cloud-sandbox machine: no device, no daemon, no heartbeat. It declares the
// cloud runtimes it can host and carries the cloud AMA environment dispatch
// targets. status stays 'online' so the UI shows it as available.
export async function createCloudMachine(
  db: D1,
  ownerId: string,
  info: { name: string; runtimes: AgentRuntime[]; amaEnvironmentId: string },
): Promise<MachineRecord> {
  const id = newId();
  const now = new Date().toISOString();
  const runtimes = info.runtimes.map((runtime) => ({ name: runtime, status: "ready" as const, checked_at: now }));
  await db
    .prepare(
      `INSERT INTO machines (id, owner_id, device_id, name, os, version, runtimes, status, hosting, ama_environment_id, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, ?, 'cloud', 'cloud', ?, 'online', 'cloud', ?, ?, ?)`,
    )
    .bind(id, ownerId, `cloud-${id}`, info.name, JSON.stringify(runtimes), info.amaEnvironmentId, now, now)
    .run();
  const row = await db.prepare("SELECT * FROM machines WHERE id = ?").bind(id).first<MachineRecord>();
  return parseMachine(row!);
}

export async function updateMachineAmaEnvironment(
  db: D1,
  machineId: string,
  ownerId: string,
  amaEnvironmentId: string,
): Promise<MachineRecord | null> {
  const result = await db
    .prepare("UPDATE machines SET ama_environment_id = ? WHERE id = ? AND owner_id = ?")
    .bind(amaEnvironmentId, machineId, ownerId)
    .run();
  if (result.meta.changes === 0) return null;
  const row = await db.prepare("SELECT * FROM machines WHERE id = ?").bind(machineId).first<MachineRecord>();
  return parseMachine(row!);
}

export interface MachineEnvironmentCandidate {
  machineId: string;
  environmentId: string;
  hosting: MachineHosting;
}

// Candidate environments for a runtime: any of the owner's machines (local or
// cloud) whose declared runtimes include it. Cloud sandboxes sort first so
// dispatch prefers them — AMA scales them per session, no runner gate.
export async function listMachineEnvironmentCandidatesForRuntime(db: D1, ownerId: string, runtime: string): Promise<MachineEnvironmentCandidate[]> {
  const values = runtimeMatchValues(runtime);
  const placeholders = values.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `
      SELECT m.id, m.ama_environment_id AS environment_id, m.hosting AS hosting
      FROM machines m, json_each(m.runtimes) rt
      WHERE m.owner_id = ?
        AND (
          (rt.type = 'text' AND rt.value IN (${placeholders}))
          OR (
            json_extract(rt.value, '$.status') = 'ready'
            AND json_extract(rt.value, '$.name') IN (${placeholders})
          )
        )
        AND m.ama_environment_id IS NOT NULL
      ORDER BY (m.hosting = 'cloud') DESC, COALESCE(m.last_heartbeat_at, m.created_at) DESC
    `,
    )
    .bind(ownerId, ...values, ...values)
    .all<{ id: string; environment_id: string; hosting: MachineHosting }>();
  return result.results.map((row) => ({ machineId: row.id, environmentId: row.environment_id, hosting: row.hosting }));
}

export async function deleteMachine(db: D1, machineId: string, ownerId: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM machines WHERE id = ? AND owner_id = ?").bind(machineId, ownerId).run();
  return result.meta.changes > 0;
}

export async function updateMachine(db: D1, machineId: string, ownerId: string, info: HeartbeatInfo): Promise<MachineRecord | null> {
  const now = new Date().toISOString();
  const sets: string[] = ["status = 'online'", "last_heartbeat_at = ?"];
  const binds: any[] = [now];

  if (info.version) {
    sets.push("version = ?");
    binds.push(info.version);
  }
  if (info.runtimes) {
    sets.push("runtimes = ?");
    binds.push(JSON.stringify(normalizeMachineRuntimes(info.runtimes, now)));
  }
  if ("usage_info" in info) {
    const usageInfo = info.usage_info;
    sets.push("usage_info = ?");
    binds.push(usageInfo == null ? null : JSON.stringify(normalizeUsageInfo(usageInfo)));
  }

  binds.push(machineId, ownerId);
  const result = await db
    .prepare(`UPDATE machines SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`)
    .bind(...binds)
    .run();
  if (result.meta.changes === 0) return null;

  const row = await db.prepare("SELECT * FROM machines WHERE id = ?").bind(machineId).first<MachineRecord>();
  return parseMachine(row!);
}

export async function listMachines(db: D1, ownerId: string): Promise<MachineWithAgentsRecord[]> {
  const result = await db
    .prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id) as session_count,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id AND s.status = 'active') as active_session_count
    FROM machines m
    WHERE m.owner_id = ?
    ORDER BY m.last_heartbeat_at DESC
  `)
    .bind(ownerId)
    .all<MachineWithAgentsRecord>();
  return result.results.map(parseMachine);
}

export async function listMachinesForRuntimeRouting(db: D1, ownerId: string): Promise<MachineRecord[]> {
  const result = await db.prepare("SELECT * FROM machines WHERE owner_id = ?").bind(ownerId).all<MachineRecord>();
  return result.results.map(parseMachine);
}

export async function getMachine(db: D1, machineId: string, ownerId: string): Promise<(MachineWithAgentsRecord & { agents: any[] }) | null> {
  const machine = await db
    .prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id) as session_count,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id AND s.status = 'active') as active_session_count
    FROM machines m WHERE m.id = ? AND m.owner_id = ?
  `)
    .bind(machineId, ownerId)
    .first<MachineWithAgentsRecord>();

  if (!machine) return null;

  const agents = await db
    .prepare(`
    SELECT a.id, a.name,
      SUM(s.status = 'active') as active_session_count,
      MAX(s.created_at) as last_session_at
    FROM agents a
    JOIN agent_sessions s ON s.agent_id = a.id
    WHERE s.machine_id = ?
    GROUP BY a.id
    ORDER BY last_session_at DESC
  `)
    .bind(machineId)
    .all();

  return { ...parseMachine(machine), agents: agents.results };
}

export interface AdminMachine extends MachineWithAgentsRecord {
  owner_name: string | null;
  owner_email: string | null;
}

export async function listAllMachines(db: D1): Promise<AdminMachine[]> {
  const result = await db
    .prepare(`
    SELECT m.*,
      (SELECT tm.name FROM realmroot_tenant_members tm WHERE tm.tenant_id = m.owner_id ORDER BY tm.created_at LIMIT 1) AS owner_name,
      (SELECT tm.email FROM realmroot_tenant_members tm WHERE tm.tenant_id = m.owner_id ORDER BY tm.created_at LIMIT 1) AS owner_email,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id) AS session_count,
      (SELECT COUNT(*) FROM agent_sessions s WHERE s.machine_id = m.id AND s.status = 'active') AS active_session_count
    FROM machines m
    ORDER BY m.last_heartbeat_at DESC
  `)
    .all<AdminMachine>();
  return result.results.map(parseMachine);
}

function parseMachine<T extends MachineRecord>(row: T): T {
  const parsed = parseJsonFields(row, ["runtimes", "usage_info"]);
  parsed.runtimes = normalizeMachineRuntimes(parsed.runtimes ?? [], parsed.last_heartbeat_at ?? parsed.created_at);
  if (parsed.usage_info) parsed.usage_info = normalizeUsageInfo(parsed.usage_info);
  return parsed;
}

function normalizeUsageInfo(info: UsageInfo): UsageInfo {
  return {
    ...info,
    windows: info.windows.map((window) => ({
      ...window,
      utilization: window.utilization < 1 ? window.utilization * 100 : window.utilization,
    })),
  };
}

const RUNTIME_BY_LABEL = Object.fromEntries(Object.entries(RUNTIME_LABELS).map(([runtime, label]) => [label, runtime])) as Record<
  string,
  AgentRuntime
>;

export function runtimeMatchValues(runtime: string): string[] {
  const normalized = normalizeRuntime(runtime);
  const canonical = (RUNTIME_BY_LABEL[normalized] ?? normalized) as AgentRuntime;
  const label = RUNTIME_LABELS[canonical];
  return label && label !== canonical ? [canonical, label] : [canonical];
}

export function runtimeReadyPredicateSql(runtimeExpr: string): string {
  return `
    (
      (
        rt.type = 'text'
        AND (rt.value = ${runtimeExpr} OR rt.value = ${runtimeLabelCaseSql(runtimeExpr)})
      )
      OR (
        json_extract(rt.value, '$.status') = 'ready'
        AND json_extract(rt.value, '$.name') = ${runtimeExpr}
      )
    )
  `;
}

function runtimeLabelCaseSql(runtimeExpr: string): string {
  const cases = Object.entries(RUNTIME_LABELS)
    .map(([runtime, label]) => `WHEN '${runtime}' THEN '${label.replace(/'/g, "''")}'`)
    .join(" ");
  return `CASE ${runtimeExpr} ${cases} END`;
}

const RUNTIME_STATUSES: readonly MachineRuntimeStatus[] = ["missing", "unauthorized", "unhealthy", "limited", "ready"];

export function normalizeMachineRuntimes(runtimes: MachineRuntime[] | string[], checkedAt: string): MachineRuntime[] {
  return runtimes.map((runtime) => {
    if (typeof runtime === "string") {
      return { name: normalizeMachineRuntimeName(runtime), status: "ready", checked_at: checkedAt };
    }
    const name = normalizeMachineRuntimeName(runtime.name);
    if (!RUNTIME_STATUSES.includes(runtime.status)) {
      throw new Error(`Invalid runtime status "${runtime.status}"`);
    }
    return {
      name,
      status: runtime.status,
      ...(runtime.detail ? { detail: runtime.detail } : {}),
      ...(runtime.reset_at ? { reset_at: runtime.reset_at } : {}),
      checked_at: runtime.checked_at || checkedAt,
    };
  });
}

function normalizeMachineRuntimeName(runtime: string): AgentRuntime {
  const normalized = normalizeRuntime(runtime);
  const canonical = RUNTIME_BY_LABEL[normalized] ?? normalized;
  if (!AGENT_RUNTIMES.includes(canonical as AgentRuntime)) {
    throw new Error(`Invalid runtime "${runtime}"`);
  }
  return canonical as AgentRuntime;
}

export async function isRuntimeAvailable(db: D1, ownerId: string, runtime: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - MACHINE_STALE_TIMEOUT_MS).toISOString();
  const values = runtimeMatchValues(runtime);
  const placeholders = values.map(() => "?").join(", ");
  const row = await db
    .prepare(`
      SELECT 1
      FROM machines m, json_each(m.runtimes) rt
      WHERE m.owner_id = ?
        AND m.status = 'online'
        AND m.last_heartbeat_at >= ?
        AND (
          (rt.type = 'text' AND rt.value IN (${placeholders}))
          OR (
            json_extract(rt.value, '$.status') = 'ready'
            AND json_extract(rt.value, '$.name') IN (${placeholders})
          )
        )
      LIMIT 1
    `)
    .bind(ownerId, cutoff, ...values, ...values)
    .first();
  return !!row;
}

export async function detectStaleMachines(db: D1): Promise<void> {
  const cutoff = new Date(Date.now() - MACHINE_STALE_TIMEOUT_MS).toISOString();
  await db.prepare("UPDATE machines SET status = 'offline' WHERE status = 'online' AND last_heartbeat_at < ?").bind(cutoff).run();
}
