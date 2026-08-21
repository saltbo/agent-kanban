import type { Agent, AgentStatus, AgentWithActivity, CreateAgentInput } from "@agent-kanban/shared";
import { type AgentRuntime, type AnyAgentRuntime, BUILTIN_TEMPLATES, hasNoScheduleTaint, MACHINE_STALE_TIMEOUT_MS } from "@agent-kanban/shared";
import { type D1, parseJsonFields } from "./db";
import { addSubkey, getOrCreateRootKey } from "./gpgKeyRepo";
import { runtimeReadyPredicateSql } from "./machineRepo";

const parseAgent = <T extends Agent>(row: T): T => {
  const parsed = parseJsonFields(row, ["skills", "subagents", "taints", "handoff_to", "metadata"]);
  parsed.reasoning_effort = typeof parsed.metadata?.reasoning_effort === "string" ? parsed.metadata.reasoning_effort : null;
  return parsed;
};

export type AgentListFilters = {
  kind?: "worker" | "leader";
  role?: string;
  runtime?: AnyAgentRuntime;
  available?: boolean;
};

async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

type AgentProfile = Pick<
  Agent,
  "name" | "bio" | "soul" | "role" | "kind" | "handoff_to" | "runtime" | "model" | "reasoning_effort" | "relay_id" | "skills" | "subagents" | "taints"
>;
type AgentActivityRow = Agent & {
  runtime_ready: number | boolean;
  todo_task_count: number;
  in_progress_task_count: number;
  in_review_task_count: number;
  done_task_count: number;
  cancelled_task_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
};

type AgentBaseRow = Agent & {
  runtime_ready: number | boolean;
};

type AgentTaskCounts = Pick<
  AgentActivityRow,
  "todo_task_count" | "in_progress_task_count" | "in_review_task_count" | "done_task_count" | "cancelled_task_count"
>;

type AgentUsageTotals = Pick<AgentActivityRow, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_creation_tokens" | "cost_micro_usd">;

function buildAgentStatus(agent: AgentActivityRow, runtimeAvailable: boolean): AgentStatus {
  return {
    schedulable: agent.kind === "worker" && !hasNoScheduleTaint(agent.taints) && runtimeAvailable,
    tasks: {
      todo: Number(agent.todo_task_count ?? 0),
      in_progress: Number(agent.in_progress_task_count ?? 0),
      in_review: Number(agent.in_review_task_count ?? 0),
      done: Number(agent.done_task_count ?? 0),
      cancelled: Number(agent.cancelled_task_count ?? 0),
    },
  };
}

export function withAgentStatus(agent: AgentWithActivity, runtimeAvailable: boolean): AgentWithActivity {
  return {
    ...agent,
    status: buildAgentStatus(
      {
        ...agent,
        runtime_ready: runtimeAvailable,
        todo_task_count: agent.status.tasks.todo,
        in_progress_task_count: agent.status.tasks.in_progress,
        in_review_task_count: agent.status.tasks.in_review,
        done_task_count: agent.status.tasks.done,
        cancelled_task_count: agent.status.tasks.cancelled,
      },
      runtimeAvailable,
    ),
  };
}

function parseAgentActivity(row: AgentActivityRow): AgentWithActivity {
  const parsed = parseAgent(row) as AgentActivityRow;
  const runtimeAvailable = !!parsed.runtime_ready;
  const {
    runtime_ready: _runtimeReady,
    todo_task_count: _todoTaskCount,
    in_progress_task_count: _inProgressTaskCount,
    in_review_task_count: _inReviewTaskCount,
    done_task_count: _doneTaskCount,
    cancelled_task_count: _cancelledTaskCount,
    ...agent
  } = parsed;
  return {
    ...agent,
    email: `${parsed.username}@mails.agent-kanban.dev`,
    status: buildAgentStatus(parsed, runtimeAvailable),
  };
}

function profileJson(agent: AgentProfile): string {
  return JSON.stringify({
    name: agent.name,
    bio: agent.bio,
    soul: agent.soul,
    role: agent.role,
    kind: agent.kind,
    handoff_to: agent.handoff_to ?? [],
    runtime: agent.runtime,
    model: agent.model,
    reasoning_effort: agent.reasoning_effort,
    relay_id: agent.relay_id ?? null,
    skills: agent.skills ?? [],
    subagents: agent.subagents ?? [],
    taints: agent.taints ?? [],
  });
}

async function profileVersion(
  agent: Pick<
    Agent,
    | "name"
    | "bio"
    | "soul"
    | "role"
    | "kind"
    | "handoff_to"
    | "runtime"
    | "model"
    | "reasoning_effort"
    | "relay_id"
    | "skills"
    | "subagents"
    | "taints"
  >,
): Promise<string> {
  return shortHash(profileJson(agent));
}

export interface PreparedAgent extends Agent {
  privateKeyJwk: JsonWebKey;
}

export interface AgentIdentity {
  id: string;
  publicKeyBase64: string;
  fingerprint: string;
  privateKeyJwk: JsonWebKey;
}

export async function prepareAgent(
  ownerId: string,
  input: CreateAgentInput,
  identity: AgentIdentity,
  builtin = false,
  amaAgentId: string | null = null,
): Promise<PreparedAgent> {
  const { id, publicKeyBase64, fingerprint, privateKeyJwk } = identity;
  const now = new Date().toISOString();
  const soul = input.soul ?? null;
  return {
    id,
    owner_id: ownerId,
    name: input.name || input.username,
    username: input.username,
    gpg_subkey_id: null,
    bio: input.bio ?? null,
    soul,
    role: input.role ?? null,
    kind: input.kind ?? "worker",
    handoff_to: input.handoff_to ?? null,
    runtime: input.runtime,
    model: input.model ?? null,
    reasoning_effort: input.reasoning_effort ?? null,
    relay_id: input.relay_id ?? null,
    skills: input.skills ?? null,
    subagents: input.subagents ?? null,
    taints: input.taints ?? null,
    version: "latest",
    public_key: publicKeyBase64,
    fingerprint,
    builtin: builtin ? 1 : 0,
    ama_agent_id: amaAgentId,
    metadata: input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {},
    created_at: now,
    updated_at: now,
    privateKeyJwk,
  };
}

export async function insertAgent(db: D1, agent: PreparedAgent, extras?: { mailboxToken?: string; gpgSubkeyId?: string }): Promise<Agent> {
  const skillsJson = agent.skills ? JSON.stringify(agent.skills) : null;
  const subagentsJson = agent.subagents ? JSON.stringify(agent.subagents) : null;
  const taintsJson = agent.taints ? JSON.stringify(agent.taints) : null;
  const handoffJson = agent.handoff_to ? JSON.stringify(agent.handoff_to) : null;
  const metadataJson = JSON.stringify(agent.metadata ?? {});
  await db
    .prepare(`
    INSERT INTO agents (id, owner_id, name, username, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints, version, public_key, private_key, fingerprint, builtin, mailbox_token, gpg_subkey_id, ama_agent_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      agent.id,
      agent.owner_id,
      agent.name,
      agent.username,
      agent.bio,
      agent.soul,
      agent.role,
      agent.kind,
      handoffJson,
      agent.runtime,
      agent.model,
      agent.relay_id ?? null,
      skillsJson,
      subagentsJson,
      taintsJson,
      agent.version,
      agent.public_key,
      JSON.stringify(agent.privateKeyJwk),
      agent.fingerprint,
      agent.builtin,
      extras?.mailboxToken ?? null,
      extras?.gpgSubkeyId ?? null,
      agent.ama_agent_id ?? null,
      metadataJson,
      agent.created_at,
      agent.updated_at,
    )
    .run();
  const { privateKeyJwk: _, ...result } = agent;
  if (extras?.gpgSubkeyId) result.gpg_subkey_id = extras.gpgSubkeyId;
  return result;
}

export async function createAgentIdentity(db: D1, ownerId: string, agentEmail: string): Promise<AgentIdentity> {
  await getOrCreateRootKey(db, ownerId);
  const subkey = await addSubkey(db, ownerId, agentEmail);
  if (!subkey) throw new Error("addSubkey returned null after getOrCreateRootKey — should not happen");
  const { x, d } = subkey.privateKeyJwk;
  if (!x || !d) throw new Error("GPG subkey produced invalid JWK — missing x or d field");
  return {
    id: subkey.keyId,
    publicKeyBase64: x,
    fingerprint: subkey.fingerprint,
    privateKeyJwk: subkey.privateKeyJwk,
  };
}

export async function createAgent(db: D1, ownerId: string, input: CreateAgentInput, identity: AgentIdentity, builtin = false): Promise<Agent> {
  const prepared = await prepareAgent(ownerId, input, identity, builtin);
  return upsertLatestAgent(db, prepared);
}

export async function seedBuiltinAgents(db: D1, ownerId: string): Promise<void> {
  const existing = await db.prepare("SELECT role FROM agents WHERE owner_id = ? AND builtin = 1").bind(ownerId).all<{ role: string }>();
  const existingRoles = new Set(existing.results.map((a) => a.role));

  const hash = Array.from(new TextEncoder().encode(ownerId)).reduce((h, b) => ((h << 5) - h + b) >>> 0, 0);
  const ownerSuffix = hash.toString(36).slice(0, 6);
  for (const tpl of BUILTIN_TEMPLATES) {
    if (tpl.role && existingRoles.has(tpl.role)) continue;
    const username = `${tpl.username ?? tpl.role!}-${ownerSuffix}`;
    const input = { ...tpl, username, runtime: tpl.runtime as AgentRuntime } as CreateAgentInput;
    const identity = await createAgentIdentity(db, ownerId, `${username}@mails.agent-kanban.dev`);
    await createAgent(db, ownerId, input, identity, true);
  }
}

export async function listAgents(db: D1, ownerId: string, filters: AgentListFilters = {}): Promise<AgentWithActivity[]> {
  const runtimeCutoff = new Date(Date.now() - MACHINE_STALE_TIMEOUT_MS).toISOString();
  let query = `
    WITH owner_agent_ids AS (
      SELECT id FROM agents WHERE owner_id = ?
    )
    SELECT a.id, a.owner_id, a.name, a.username, a.gpg_subkey_id, a.bio, a.soul, a.role, a.kind, a.handoff_to, a.runtime, a.model, a.relay_id, a.skills, a.subagents, a.taints,
      a.version,
      a.public_key, a.fingerprint, a.builtin, a.ama_agent_id, a.metadata, a.created_at, a.updated_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM machines m, json_each(m.runtimes) rt
        WHERE m.owner_id = a.owner_id
          AND m.status = 'online'
          AND m.last_heartbeat_at >= ?
          AND ${runtimeReadyPredicateSql("a.runtime")}
      ) THEN 1 ELSE 0 END as runtime_ready,
      COALESCE(tc.todo_task_count, 0) as todo_task_count,
      COALESCE(tc.in_progress_task_count, 0) as in_progress_task_count,
      COALESCE(tc.in_review_task_count, 0) as in_review_task_count,
      COALESCE(tc.done_task_count, 0) as done_task_count,
      COALESCE(tc.cancelled_task_count, 0) as cancelled_task_count,
      COALESCE(su.input_tokens, 0) as input_tokens,
      COALESCE(su.output_tokens, 0) as output_tokens,
      COALESCE(su.cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(su.cache_creation_tokens, 0) as cache_creation_tokens,
      COALESCE(su.cost_micro_usd, 0) as cost_micro_usd
    FROM agents a
    LEFT JOIN (
      SELECT assigned_to,
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo_task_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_task_count,
        SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review_task_count,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_task_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_task_count
      FROM tasks
      WHERE assigned_to IS NOT NULL
      GROUP BY assigned_to
    ) tc ON tc.assigned_to = a.id
    LEFT JOIN (
      SELECT
        agent_id,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cost_micro_usd) AS cost_micro_usd
      FROM (
        SELECT agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        FROM agent_sessions
        WHERE agent_id IN (SELECT id FROM owner_agent_ids)
        UNION ALL
        SELECT agent_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        FROM ama_agent_sessions
        WHERE agent_id IN (SELECT id FROM owner_agent_ids)
      )
      GROUP BY agent_id
    ) su ON su.agent_id = a.id
    WHERE a.owner_id = ? AND COALESCE(a.version, 'latest') = 'latest'
  `;
  const binds: unknown[] = [ownerId, runtimeCutoff, ownerId];
  if (filters.kind) {
    query += " AND a.kind = ?";
    binds.push(filters.kind);
  }
  if (filters.role) {
    query += " AND a.role = ?";
    binds.push(filters.role);
  }
  if (filters.runtime) {
    query += " AND a.runtime = ?";
    binds.push(filters.runtime);
  }
  query += " ORDER BY a.created_at DESC";
  const result = await db
    .prepare(query)
    .bind(...binds)
    .all<AgentActivityRow>();
  const agents = result.results.map((r) => parseAgentActivity(r));
  if (filters.available === undefined) return agents;
  return agents.filter((agent) => agent.status.schedulable === filters.available);
}

export async function getAgent(db: D1, agentId: string, ownerId: string): Promise<AgentWithActivity | null> {
  const runtimeCutoff = new Date(Date.now() - MACHINE_STALE_TIMEOUT_MS).toISOString();
  const [agentResult, taskCountResult, usageResult] = await db.batch([
    db
      .prepare(`
    SELECT a.id, a.owner_id, a.name, a.username, a.gpg_subkey_id, a.bio, a.soul, a.role, a.kind, a.handoff_to, a.runtime, a.model, a.relay_id, a.skills, a.subagents, a.taints,
      a.version,
      a.public_key, a.fingerprint, a.builtin, a.ama_agent_id, a.metadata, a.created_at, a.updated_at,
      CASE WHEN EXISTS (
        SELECT 1 FROM machines m, json_each(m.runtimes) rt
        WHERE m.owner_id = a.owner_id
          AND m.status = 'online'
          AND m.last_heartbeat_at >= ?
          AND ${runtimeReadyPredicateSql("a.runtime")}
      ) THEN 1 ELSE 0 END as runtime_ready
    FROM agents a
    WHERE a.id = ? AND a.owner_id = ?
  `)
      .bind(runtimeCutoff, agentId, ownerId),
    db
      .prepare(`
      SELECT
        SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo_task_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_task_count,
        SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review_task_count,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_task_count,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_task_count
      FROM tasks
      WHERE assigned_to = ?
    `)
      .bind(agentId),
    db
      .prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(cost_micro_usd), 0) AS cost_micro_usd
      FROM (
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        FROM agent_sessions
        WHERE agent_id = ?
        UNION ALL
        SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_micro_usd
        FROM ama_agent_sessions
        WHERE agent_id = ?
      )
    `)
      .bind(agentId, agentId),
  ]);
  const agent = agentResult.results[0] as AgentBaseRow | undefined;
  if (!agent) return null;
  const taskCounts = taskCountResult.results[0] as AgentTaskCounts;
  const usage = usageResult.results[0] as AgentUsageTotals;
  return parseAgentActivity({ ...agent, ...taskCounts, ...usage });
}

export async function updateAgent(
  db: D1,
  agentId: string,
  updates: Partial<
    Pick<
      Agent,
      "name" | "bio" | "soul" | "role" | "handoff_to" | "runtime" | "model" | "reasoning_effort" | "relay_id" | "skills" | "subagents" | "taints"
    >
  >,
): Promise<Agent | null> {
  const agent = await db
    .prepare(
      "SELECT id, owner_id, name, username, gpg_subkey_id, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints, version, public_key, private_key, fingerprint, builtin, mailbox_token, metadata, created_at, updated_at FROM agents WHERE id = ?",
    )
    .bind(agentId)
    .first<Agent & { private_key: string; mailbox_token: string | null }>();
  if (!agent) return null;
  if (agent.version !== "latest") return null;

  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];
  const applied: Partial<Agent> = {};
  const parsedAgent = parseAgent(agent);

  const jsonFields = new Set(["skills", "subagents", "taints", "handoff_to"]);
  const fields = ["name", "bio", "soul", "role", "handoff_to", "runtime", "model", "relay_id", "skills", "subagents", "taints"] as const;
  for (const field of fields) {
    if (field in updates && (updates as any)[field] !== undefined) {
      sets.push(`${field} = ?`);
      const val = (updates as any)[field];
      binds.push(jsonFields.has(field) && val != null ? JSON.stringify(val) : val);
      (applied as any)[field] = val;
    }
  }
  if ("reasoning_effort" in updates && updates.reasoning_effort !== undefined) {
    const metadata = { ...(parsedAgent.metadata ?? {}) };
    if (updates.reasoning_effort) metadata.reasoning_effort = updates.reasoning_effort;
    else delete metadata.reasoning_effort;
    sets.push("metadata = ?");
    binds.push(JSON.stringify(metadata));
    applied.metadata = metadata;
    applied.reasoning_effort = updates.reasoning_effort ?? null;
  }
  const updatedProfile = { ...parsedAgent, ...applied } as AgentSnapshot;
  if (profileJson(parsedAgent as AgentSnapshot) === profileJson(updatedProfile)) {
    return getAgent(db, agentId, agent.owner_id);
  }

  await insertAgentSnapshot(db, parsedAgent as AgentSnapshot, await profileVersion(parsedAgent as AgentSnapshot), now);
  binds.push(agentId);
  await db
    .prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getAgent(db, agentId, agent.owner_id);
}

type AgentSnapshot = Agent & { private_key: string; mailbox_token: string | null };

function jsonOrNull(value: unknown | null): string | null {
  return value ? JSON.stringify(value) : null;
}

async function getLatestAgentSnapshot(db: D1, username: string, ownerId: string): Promise<AgentSnapshot | null> {
  const row = await db
    .prepare(
      "SELECT id, owner_id, name, username, gpg_subkey_id, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints, version, public_key, private_key, fingerprint, builtin, mailbox_token, metadata, created_at, updated_at FROM agents WHERE username = ? AND owner_id = ? AND version = 'latest'",
    )
    .bind(username, ownerId)
    .first<Agent & { private_key: string; mailbox_token: string | null }>();
  return row ? (parseAgent(row) as AgentSnapshot) : null;
}

async function insertAgentSnapshot(db: D1, source: AgentSnapshot, version: string, now: string): Promise<string> {
  const existing = await db
    .prepare(
      "SELECT id, name, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints FROM agents WHERE username = ? AND version = ?",
    )
    .bind(source.username, version)
    .first<AgentProfile & { id: string }>();
  if (existing) {
    if (profileJson(parseAgent(existing as Agent)) !== profileJson(source)) {
      throw new Error(`Agent snapshot hash collision: ${source.username}@${version}`);
    }
    return existing.id;
  }

  const snapshotId = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO agents (id, owner_id, name, username, gpg_subkey_id, bio, soul, role, kind, handoff_to, runtime, model, relay_id, skills, subagents, taints, version, public_key, private_key, fingerprint, builtin, mailbox_token, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      snapshotId,
      source.owner_id,
      source.name,
      source.username,
      source.gpg_subkey_id,
      source.bio,
      source.soul,
      source.role,
      source.kind,
      jsonOrNull(source.handoff_to),
      source.runtime,
      source.model,
      source.relay_id ?? null,
      jsonOrNull(source.skills),
      jsonOrNull(source.subagents),
      jsonOrNull(source.taints),
      version,
      source.public_key,
      source.private_key,
      source.fingerprint,
      source.builtin,
      source.mailbox_token,
      JSON.stringify(source.metadata ?? {}),
      now,
      now,
    )
    .run();
  return snapshotId;
}

async function updateLatestFromPrepared(
  db: D1,
  latest: AgentSnapshot,
  agent: PreparedAgent,
  extras: { mailboxToken?: string; gpgSubkeyId?: string } | undefined,
  now: string,
): Promise<void> {
  await db
    .prepare(`
      UPDATE agents
      SET name = ?, gpg_subkey_id = ?, bio = ?, soul = ?, role = ?, kind = ?, handoff_to = ?, runtime = ?, model = ?, relay_id = ?,
          skills = ?, subagents = ?, taints = ?, public_key = ?, private_key = ?, fingerprint = ?, builtin = ?, mailbox_token = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(
      agent.name,
      extras?.gpgSubkeyId ?? latest.gpg_subkey_id,
      agent.bio,
      agent.soul,
      agent.role,
      agent.kind,
      jsonOrNull(agent.handoff_to),
      agent.runtime,
      agent.model,
      agent.relay_id ?? null,
      jsonOrNull(agent.skills),
      jsonOrNull(agent.subagents),
      jsonOrNull(agent.taints),
      latest.public_key,
      latest.private_key,
      latest.fingerprint,
      agent.builtin,
      extras?.mailboxToken ?? latest.mailbox_token,
      // Merge, never replace: UI-set keys (e.g. reasoning_effort) survive
      // re-registration, which only knows the keys in agent.metadata.
      JSON.stringify({ ...(latest.metadata ?? {}), ...(agent.metadata ?? {}) }),
      now,
      latest.id,
    )
    .run();
}

export async function upsertLatestAgent(db: D1, agent: PreparedAgent, extras?: { mailboxToken?: string; gpgSubkeyId?: string }): Promise<Agent> {
  const latest = await getLatestAgentSnapshot(db, agent.username, agent.owner_id);
  if (!latest) return insertAgent(db, agent, extras);

  const now = new Date().toISOString();
  // parseAgent so reasoning_effort (derived from metadata) compares equal to
  // the prepared profile — otherwise every idempotent re-register churns a
  // spurious snapshot + UPDATE.
  const parsedLatest = parseAgent(latest);
  if (profileJson(parsedLatest) === profileJson(agent)) {
    const current = await getAgent(db, latest.id, agent.owner_id);
    if (!current) throw new Error("Latest agent missing during update");
    return current;
  }

  await insertAgentSnapshot(db, latest, await profileVersion(parsedLatest), now);
  await updateLatestFromPrepared(db, latest, agent, extras, now);
  const updated = await getAgent(db, latest.id, agent.owner_id);
  if (!updated) throw new Error("Latest agent missing after update");
  return updated;
}

export async function deleteAgent(db: D1, agentId: string): Promise<boolean> {
  const agent = await db
    .prepare("SELECT owner_id, username, version FROM agents WHERE id = ?")
    .bind(agentId)
    .first<Pick<Agent, "owner_id" | "username" | "version">>();
  if (!agent || agent.version !== "latest") return false;

  await db
    .prepare(
      "UPDATE tasks SET assigned_to = NULL WHERE assigned_to IN (SELECT id FROM agents WHERE owner_id = ? AND username = ?) AND status IN ('todo', 'in_progress')",
    )
    .bind(agent.owner_id, agent.username)
    .run();
  const result = await db.prepare("DELETE FROM agents WHERE owner_id = ? AND username = ?").bind(agent.owner_id, agent.username).run();
  return result.meta.changes > 0;
}

export async function getAgentLogs(db: D1, agentId: string): Promise<any[]> {
  const result = await db
    .prepare(
      "SELECT tl.*, t.title as task_title FROM task_actions tl JOIN tasks t ON tl.task_id = t.id WHERE tl.actor_id = ? ORDER BY tl.created_at DESC LIMIT 100",
    )
    .bind(agentId)
    .all();
  return result.results;
}

export async function getAgentPrivateKey(db: D1, agentId: string): Promise<JsonWebKey | null> {
  const row = await db.prepare("SELECT private_key FROM agents WHERE id = ?").bind(agentId).first<{ private_key: string }>();
  return row ? JSON.parse(row.private_key) : null;
}

export async function updateAgentMetadataAnnotations(db: D1, ownerId: string, agentId: string, annotations: Record<string, unknown>): Promise<void> {
  const row = await db.prepare("SELECT metadata FROM agents WHERE id = ? AND owner_id = ?").bind(agentId, ownerId).first<{ metadata: string }>();
  if (!row) throw new Error("Agent not found");
  const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
  const existing =
    metadata.annotations && typeof metadata.annotations === "object" && !Array.isArray(metadata.annotations) ? metadata.annotations : {};
  metadata.annotations = { ...(existing as Record<string, unknown>), ...annotations };
  await db
    .prepare("UPDATE agents SET metadata = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(JSON.stringify(metadata), new Date().toISOString(), agentId, ownerId)
    .run();
}

export async function setAgentGpgSubkeyId(db: D1, agentId: string, gpgSubkeyId: string): Promise<void> {
  await db.prepare("UPDATE agents SET gpg_subkey_id = ? WHERE id = ?").bind(gpgSubkeyId, agentId).run();
}

// The AMA agent id is shared by every version row of the same username, so set
// it across the whole lineage (latest + snapshots), keyed by ownership.
export async function setAgentAmaId(db: D1, ownerId: string, agentId: string, amaAgentId: string): Promise<void> {
  const row = await db.prepare("SELECT username FROM agents WHERE id = ? AND owner_id = ?").bind(agentId, ownerId).first<{ username: string }>();
  if (!row) throw new Error("Agent not found");
  await db.prepare("UPDATE agents SET ama_agent_id = ? WHERE owner_id = ? AND username = ?").bind(amaAgentId, ownerId, row.username).run();
}

export async function getAgentAmaId(db: D1, agentId: string): Promise<string | null> {
  const row = await db.prepare("SELECT ama_agent_id FROM agents WHERE id = ?").bind(agentId).first<{ ama_agent_id: string | null }>();
  return row?.ama_agent_id ?? null;
}

// Latest, non-builtin worker agents that predate AMA and so have no backing AMA
// agent. Only workers are dispatchable; leaders authenticate/review inside AK
// and do not mirror to AMA. Snapshots share the username's ama_agent_id via
// setAgentAmaId, and builtin agents are never given one, so both are excluded.
export async function listAgentsMissingAmaAgent(db: D1, ownerId: string): Promise<{ id: string; username: string; runtime: string }[]> {
  const result = await db
    .prepare(
      "SELECT id, username, runtime FROM agents WHERE owner_id = ? AND version = 'latest' AND builtin = 0 AND kind = 'worker' AND ama_agent_id IS NULL",
    )
    .bind(ownerId)
    .all<{ id: string; username: string; runtime: string }>();
  return result.results;
}

export async function getAgentMailboxToken(db: D1, agentId: string): Promise<string | null> {
  const row = await db.prepare("SELECT mailbox_token FROM agents WHERE id = ?").bind(agentId).first<{ mailbox_token: string | null }>();
  return row?.mailbox_token ?? null;
}
