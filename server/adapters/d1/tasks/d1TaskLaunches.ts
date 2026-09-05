import type { CreateSessionRequest } from "@realmroot/enbor-sdk";
import { type D1, newLongId } from "@server/db";
import type { TaskLaunchLease, TaskLaunchStore } from "@server/usecases/tasks/dispatchTaskLaunches";
import type { TaskClaimSessionRecoveryStore } from "@server/usecases/tasks/recoverTaskClaimSession";
import type { TaskLaunchSettlementStore } from "@server/usecases/tasks/settleTaskLaunches";
import type { TaskLaunchBootstrap, TaskLaunchBootstrapStore } from "@server/usecases/tasks/taskLaunchBootstrap";

const launchPath = '$."agent-kanban.dev/launch"';
const sessionPath = '$.annotations."agent-kanban.dev/session-id"';
const obsolete = `(t.status IN ('done', 'cancelled') OR t.assigned_to IS NOT json_extract(t.metadata, '${launchPath}.assignee_actor_id')
  OR json_extract(t.metadata, '${launchPath}.replacement_actor_id') IS NOT NULL)`;
const eligible = `t.status = 'todo' AND t.active_claim_id IS NULL AND t.scheduled_at IS NULL
  AND t.assigned_to = json_extract(t.metadata, '$."agent-kanban.dev/launch".assignee_actor_id')
  AND t.assignee_identity_type = 'realmroot_actor'
  AND json_extract(t.metadata, '${launchPath}.replacement_actor_id') IS NULL
  AND NOT EXISTS (SELECT 1 FROM task_dependencies td JOIN tasks dep ON dep.id = td.depends_on
    WHERE td.task_id = t.id AND dep.status NOT IN ('done', 'cancelled'))`;

export async function listReadyDependentLaunches(db: D1, ownerId: string, dependencyId: string, afterId: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT t.id FROM tasks t JOIN boards b ON b.id = t.board_id
    WHERE b.owner_id = ? AND t.id > ? AND (${eligible})
      AND json_extract(t.metadata, '${launchPath}.state') IN ('pending', 'preparing', 'requested')
      AND EXISTS (SELECT 1 FROM task_dependencies td WHERE td.task_id = t.id AND td.depends_on = ?)
    ORDER BY t.id LIMIT 4`)
    .bind(ownerId, afterId, dependencyId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

interface Launch extends TaskLaunchLease {
  bootstrap_vault_id?: string;
  state: string;
  project_id: string | null;
  session_id: string | null;
  secret_ref: string | null;
  secret_expires_at: string | null;
  request_json: string | null;
  bootstrap_json: string | null;
  last_error: string | null;
}
interface Snapshot {
  task_id: string;
  owner_id: string;
  launch_json: string;
  eligible: number;
  obsolete: number;
}

export function d1TaskLaunchRepository(
  db: D1,
  scope?: { ownerId: string; taskId: string },
): TaskLaunchStore & TaskLaunchSettlementStore & TaskLaunchBootstrapStore & TaskClaimSessionRecoveryStore {
  async function read(
    ownerId?: string,
    launchId?: string,
    states?: readonly string[],
    limit = 20,
    acquisition?: { now: Date; mode: "runnable" | "requested" | "settlement" },
  ): Promise<Snapshot[]> {
    const filters = [`json_type(t.metadata, '${launchPath}') = 'object'`];
    const values: unknown[] = [];
    if (scope) {
      filters.push("b.owner_id = ? AND t.id = ?");
      values.push(scope.ownerId, scope.taskId);
    }
    if (ownerId !== undefined) {
      filters.push("b.owner_id = ?");
      values.push(ownerId);
    }
    if (launchId !== undefined) {
      filters.push(`json_extract(t.metadata, '${launchPath}.id') = ?`);
      values.push(launchId);
    }
    if (states) {
      filters.push(`json_extract(t.metadata, '${launchPath}.state') IN (${states.map(() => "?").join(",")})`);
      values.push(...states);
    }
    if (acquisition) {
      filters.push(`COALESCE(julianday(json_extract(t.metadata, '${launchPath}.lease_expires_at')), 0) <= julianday(?)`);
      values.push(acquisition.now.toISOString());
      if (acquisition.mode === "runnable") filters.push(`(${eligible})`);
      if (acquisition.mode === "settlement") filters.push(obsolete);
    }
    const rows = await db
      .prepare(`SELECT t.id AS task_id, b.owner_id,
      json_extract(t.metadata, '${launchPath}') AS launch_json,
      CASE WHEN ${eligible} THEN 1 ELSE 0 END AS eligible,
      CASE WHEN ${obsolete} THEN 1 ELSE 0 END AS obsolete
      FROM tasks t JOIN boards b ON b.id = t.board_id WHERE ${filters.join(" AND ")}
      ORDER BY t.created_at, t.id LIMIT ?`)
      .bind(...values, limit)
      .all<Snapshot>();
    return rows.results;
  }
  async function save(snapshot: Snapshot, launch: Launch, now: Date, requireEligible = false): Promise<boolean> {
    const result = await db
      .prepare(`UPDATE tasks AS t SET
      metadata = json_set(metadata, '${launchPath}', json(?), '${sessionPath}', ?),
      version = version + 1, updated_at = ?
      WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
        AND json_extract(metadata, '${launchPath}') = ? ${requireEligible ? `AND (${eligible})` : ""}`)
      .bind(JSON.stringify(launch), launch.session_id, now.toISOString(), snapshot.task_id, snapshot.owner_id, snapshot.launch_json)
      .run();
    return result.meta.changes === 1;
  }
  async function change(lease: TaskLaunchLease, now: Date, update: (launch: Launch) => boolean, requireEligible = false) {
    const [snapshot] = await read(lease.owner_id, lease.id);
    if (!snapshot) return false;
    const launch = JSON.parse(snapshot.launch_json) as Launch;
    if (launch.lease_token !== lease.lease_token || Date.parse(launch.lease_expires_at) <= now.getTime()) return false;
    if (!update(launch)) return false;
    return save(snapshot, launch, now, requireEligible);
  }
  async function acquire(states: readonly string[], now: Date, limit: number, mode: "runnable" | "requested" | "settlement") {
    const leases: Launch[] = [];
    for (const snapshot of await read(undefined, undefined, states, limit, { now, mode })) {
      const launch = JSON.parse(snapshot.launch_json) as Launch;
      if (launch.lease_expires_at && Date.parse(launch.lease_expires_at) > now.getTime()) continue;
      if (mode === "runnable" && !snapshot.eligible) continue;
      if (mode === "settlement" && !snapshot.obsolete) continue;
      launch.lease_token = newLongId();
      launch.lease_expires_at = new Date(now.getTime() + 60_000).toISOString();
      launch.state = mode === "runnable" ? "preparing" : mode === "settlement" ? "settling" : "requested";
      if (mode !== "settlement") launch.attempts++;
      if (await save(snapshot, launch, now, mode === "runnable")) leases.push(launch);
    }
    return leases;
  }
  return {
    saveBootstrapLocation: (lease, projectId, vaultId, now) =>
      change(
        lease,
        now,
        (launch) => {
          if (
            launch.state !== "preparing" ||
            (launch.project_id && launch.project_id !== projectId) ||
            (launch.bootstrap_vault_id && launch.bootstrap_vault_id !== vaultId)
          )
            return false;
          launch.project_id = projectId;
          launch.bootstrap_vault_id = vaultId;
          return true;
        },
        true,
      ),
    async findClaimRequest(ownerId, taskId, agentActorId) {
      const row = await db
        .prepare(`SELECT json_extract(t.metadata, '${launchPath}') AS launch_json
        FROM tasks t JOIN boards b ON b.id = t.board_id
        WHERE t.id = ? AND b.owner_id = ? AND t.assigned_to = ? AND (${eligible})
          AND json_extract(t.metadata, '${launchPath}.state') = 'requested'`)
        .bind(taskId, ownerId, agentActorId)
        .first<{ launch_json: string }>();
      if (!row) return null;
      const launch = JSON.parse(row.launch_json) as Launch;
      return launch.request_json && launch.project_id && !launch.session_id
        ? { launchId: launch.id, projectId: launch.project_id, request: JSON.parse(launch.request_json) as CreateSessionRequest }
        : null;
    },
    async recordRecoveredSession(ownerId, launchId, projectId, sessionId, now) {
      const [snapshot] = await read(ownerId, launchId);
      if (!snapshot) return false;
      const launch = JSON.parse(snapshot.launch_json) as Launch;
      if (launch.project_id !== projectId || !launch.request_json) return false;
      if (launch.session_id) return launch.session_id === sessionId;
      if (launch.state !== "requested") return false;
      launch.session_id = sessionId;
      launch.state = "started";
      launch.lease_token = "";
      launch.lease_expires_at = "";
      launch.last_error = null;
      return save(snapshot, launch, now);
    },
    acquireRunnable: (now, limit = 20) => acquire(["pending", "preparing"], now, limit, "runnable"),
    acquireRequested: (now, limit = 20) => acquire(["requested"], now, limit, "requested"),
    acquireSettlement: (now, limit = 20) => acquire(["pending", "preparing", "started", "settling", "failed"], now, limit, "settlement"),
    async findRequested(ownerId, launchId) {
      const [snapshot] = await read(ownerId, launchId);
      if (!snapshot) return null;
      const launch = JSON.parse(snapshot.launch_json) as Launch;
      return launch.request_json && launch.project_id
        ? { projectId: launch.project_id, request: JSON.parse(launch.request_json) as CreateSessionRequest, sessionId: launch.session_id }
        : null;
    },
    saveRequest: (lease, input, now) =>
      change(
        lease,
        now,
        (launch) => {
          if (launch.state !== "preparing" || launch.request_json || (launch.project_id && launch.project_id !== input.projectId)) return false;
          launch.project_id = input.projectId;
          launch.request_json = JSON.stringify(input.request);
          launch.state = "requested";
          launch.lease_expires_at = new Date(now.getTime() + 60_000).toISOString();
          return true;
        },
        true,
      ),
    recordSession: (lease, sessionId, now) =>
      change(lease, now, (launch) => {
        if (launch.state !== "requested" || launch.session_id) return false;
        launch.session_id = sessionId;
        launch.state = "started";
        launch.lease_token = "";
        launch.lease_expires_at = "";
        launch.last_error = null;
        return true;
      }),
    async recordFailure(lease, phase, now) {
      await change(lease, now, (launch) => {
        launch.last_error = `${phase} failed`;
        return true;
      });
    },
    completeSettlement: (lease, now) =>
      change(lease, now, (launch) => {
        if (launch.state !== "settling") return false;
        launch.state = "settled";
        launch.lease_token = "";
        launch.lease_expires_at = "";
        launch.last_error = null;
        return true;
      }),
    async findBootstrap(ownerId, launchId) {
      const [snapshot] = await read(ownerId, launchId);
      if (!snapshot) return null;
      const launch = JSON.parse(snapshot.launch_json) as Launch;
      return launch.bootstrap_json ? (JSON.parse(launch.bootstrap_json) as TaskLaunchBootstrap) : null;
    },
    saveBootstrap: (lease, bootstrap, now) =>
      change(lease, now, (launch) => {
        if (
          launch.state !== "preparing" ||
          launch.request_json ||
          launch.bootstrap_json ||
          (launch.project_id && launch.project_id !== bootstrap.projectId)
        )
          return false;
        launch.project_id = bootstrap.projectId;
        launch.secret_ref = bootstrap.secretRef;
        launch.secret_expires_at = bootstrap.expiresAt;
        launch.bootstrap_json = JSON.stringify(bootstrap);
        return true;
      }),
    recordBootstrapRefresh: (lease, secretRef, expiresAt, now) =>
      change(lease, now, (launch) => {
        if (
          !["preparing", "requested", "started"].includes(launch.state) ||
          !launch.bootstrap_json ||
          launch.secret_ref !== secretRef ||
          !launch.secret_expires_at ||
          Date.parse(launch.secret_expires_at) >= expiresAt.getTime() ||
          expiresAt <= now
        )
          return false;
        launch.secret_expires_at = expiresAt.toISOString();
        launch.bootstrap_json = JSON.stringify({ ...JSON.parse(launch.bootstrap_json), expiresAt: expiresAt.toISOString() });
        return true;
      }),
  };
}

/** Reserve retirement before remote cleanup so the old Session cannot claim. */
export async function reserveTaskLaunchReplacement(
  db: D1,
  input: { ownerId: string; taskId: string; assigneeActorId: string; expectedVersion: number },
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE tasks SET
    metadata = json_set(metadata, '${launchPath}.replacement_actor_id', ?), version = version + 1, updated_at = ?
    WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
      AND version = ? AND status = 'todo' AND active_claim_id IS NULL
      AND json_type(metadata, '${launchPath}') = 'object'
      AND (json_extract(metadata, '${launchPath}.replacement_actor_id') IS NULL
        OR json_extract(metadata, '${launchPath}.replacement_actor_id') = ?)`)
    .bind(input.assigneeActorId, new Date().toISOString(), input.taskId, input.ownerId, input.expectedVersion, input.assigneeActorId)
    .run();
  return result.meta.changes === 1;
}
