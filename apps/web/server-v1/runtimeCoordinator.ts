import { AGENT_RUNTIMES, type AgentRuntime, hasNoScheduleTaint, type Task } from "@agent-kanban/shared";
import { HTTPException } from "hono/http-exception";
import { getAgent } from "./agentRepo";
import type { D1 } from "./db";
import { createLogger } from "./logger";
import { type TaskRuntimeSource, taskRuntimeSource } from "./runtimeBinding";
import { compareAndSetTaskRuntimeSource, listPendingTaskRuntimeBindings, persistInferredAmaTaskRuntimeSource } from "./runtimeBindingRepo";
import { resolveRuntimeSourceAvailability, selectRuntimeSource } from "./runtimeRouter";
import { dispatchTaskToAma, releaseTaskRuntimeBinding } from "./taskDispatch";
import type { Env } from "./types";

const logger = createLogger("runtimeCoordinator");

interface DispatchOptions {
  apiOrigin: string;
  takeover?: boolean;
  recordFailure?: boolean;
}

export async function resolveAssignableWorkerRuntimeSource(
  db: D1,
  env: Env,
  ownerId: string,
  agentId: string,
  missingStatus: 400 | 404,
): Promise<TaskRuntimeSource> {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) throw new HTTPException(missingStatus, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(agent.taints)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }

  const runtime = agent.runtime as AgentRuntime;
  const source = selectRuntimeSource(await resolveRuntimeSourceAvailability(db, env, ownerId, runtime, agent.model));
  if (!source) {
    throw new HTTPException(409, {
      message: `Runtime "${runtime}" is not available on any AMA runner or online legacy machine.`,
    });
  }
  return source;
}

export async function dispatchAssignedTask(db: D1, env: Env, ownerId: string, task: Task, options: DispatchOptions): Promise<Task> {
  if (taskRuntimeSource(task) !== "ama") return task;
  return await dispatchTaskToAma(db, env, ownerId, task, options);
}

export async function releaseAssignedTaskRuntime(
  db: D1,
  env: Env,
  ownerId: string,
  task: Task,
  reason: "user_requested" | "timeout" | "policy" | "runtime_error" = "user_requested",
): Promise<Task> {
  if (taskRuntimeSource(task) === "legacy") return task;
  return await releaseTaskRuntimeBinding(db, env, ownerId, task, reason);
}

export async function routePendingTasks(db: D1, env: Env): Promise<void> {
  const availabilityByRuntime = new Map<string, Awaited<ReturnType<typeof resolveRuntimeSourceAvailability>>>();
  for (const row of await listPendingTaskRuntimeBindings(db)) {
    if (!AGENT_RUNTIMES.includes(row.runtime as AgentRuntime)) continue;
    if (row.hasAmaBinding) {
      if (!row.current) await persistInferredAmaTaskRuntimeSource(db, row.id, row.assignedTo);
      continue;
    }

    const runtime = row.runtime as AgentRuntime;
    const cacheKey = JSON.stringify([row.ownerId, runtime, row.model]);
    let availability = availabilityByRuntime.get(cacheKey);
    if (!availability) {
      availability = await resolveRuntimeSourceAvailability(db, env, row.ownerId, runtime, row.model);
      availabilityByRuntime.set(cacheKey, availability);
    }

    let next = row.current;
    if (!row.current) {
      next = selectRuntimeSource(availability);
    } else if (row.current === "legacy" && !availability.legacy && availability.ama) {
      next = "ama";
    } else if (row.current === "ama" && !availability.ama && availability.legacy) {
      next = "legacy";
    }
    if (!next || next === row.current) continue;
    if (!(await compareAndSetTaskRuntimeSource(db, row.id, row.assignedTo, row.current, next))) continue;
    logger.info(`task runtime source selected task=${row.id} runtime=${runtime} previous=${row.current ?? "unrouted"} next=${next}`);
  }
}
