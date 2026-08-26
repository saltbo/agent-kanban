import {
  AGENT_RUNTIMES,
  type AgentRuntime,
  type AgentTaint,
  AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS,
  AMA_BACKFILL_FAILED_TAINT_KEY,
  type AnyAgentRuntime,
  type CreateAgentInput,
  type CreateSubagentInput,
  findInvalidSkillRef,
  hasNoScheduleTaint,
  type InstallableRepo,
  isBoardType,
  isValidAgentRole,
  isValidUsername,
  LEADER_AGENT_RUNTIMES,
  MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS,
  MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS,
  MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS,
  MAINTAINER_TAINT_KEY,
  type MachineRuntime,
  parseScheduledAt,
  RESERVED_ROLES,
  type Task,
  type IdentityType as TaskIdentityType,
  type UsageInfo,
  type UsageWindow,
  validateTransition,
} from "@agent-kanban/shared";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createAgentIdentity,
  deleteAgent,
  getAgent,
  getAgentLogs,
  getAgentMailboxToken,
  listAgents,
  listAgentsMissingAmaAgent,
  prepareAgent,
  updateAgent,
  upsertLatestAgent,
  withAgentStatus,
} from "./agentRepo";
import {
  closeSession,
  createAmaAgentSession,
  createSession,
  getAmaAgentSession,
  listSessions,
  reopenSession,
  updateSessionUsage,
} from "./agentSessionRepo";
import { createAmaCloudSandboxEnvironment, ensureAmaOwnerIntegration, getAmaProjectId, resolveAmaProjectId } from "./amaOwnerIntegrationRepo";
import {
  type AmaRunner,
  AmaUserAuthError,
  amaEnvironmentExists,
  archiveAmaAgent,
  archiveAmaEnvironment,
  archiveAmaMemoryStore,
  createAmaEnvironment,
  createAmaHttpAgentTrigger,
  createAmaMemoryStore,
  createAmaScheduledAgentTrigger,
  createAmaSessionSecret,
  createAmaVault,
  deleteAmaScheduledAgentTrigger,
  deleteAmaTrigger,
  getAmaSessionSocketUrl,
  isAmaTaskDispatchConfigured,
  listAmaMemoryStoreMemories,
  listAmaRunners,
  listAmaSessions,
  listAmaTriggerRuns,
  listAmaVaultCredentials,
  proxyAmaSessionSocket,
  readAmaSession,
  updateAmaHttpAgentTrigger,
  updateAmaScheduledAgentTrigger,
  updateAmaVaultCredentialSecret,
} from "./amaRuntime";
import { authMiddleware } from "./auth";
import {
  type BoardMaintainer,
  createBoardMaintainer,
  deleteBoardMaintainer,
  getBoardMaintainer,
  getOwnedBoard,
  isActiveMaintainerForBoard,
  isActiveMaintainerForRepository,
  listBoardMaintainers,
  markBoardMaintainerHttpTriggerSerialized,
  setBoardMaintainerVaultId,
  updateBoardMaintainer,
} from "./boardMaintainerRepo";
import {
  createBoard,
  createBoardLabel,
  deleteBoard,
  deleteBoardLabel,
  getBoard,
  getBoardByName,
  getBoardBySlug,
  listBoards,
  updateBoard,
  updateBoardLabel,
} from "./boardRepo";
import { listBoardRepositories } from "./boardRepositoryRepo";
import { createBoardSSEResponse, createPublicBoardSSEResponse } from "./boardSSE";
import { cliVersionMiddleware } from "./cliVersion";
import { type D1, newLongId } from "./db";
import { isGithubAppConfigured, listInstallationRepositories, mintGithubInstallationToken, recordInstallationFromSetup } from "./githubApp";
import { getInstallationsForOwner, repoAppStatus, repoAppStatusBatch } from "./githubInstallations";
import {
  handleGithubInstallationEvent,
  handleGithubInstallationRepositoriesEvent,
  handleGithubMaintainerEvent,
  handleGithubPullRequestEvent,
  verifyGithubSignature,
} from "./githubWebhook";
import { legacyMachineHeartbeatFresh } from "./legacyRuntime";
import { createLogger } from "./logger";
import {
  createCloudMachine,
  deleteMachine,
  detectStaleMachines,
  getMachine,
  listAllMachines,
  listMachines,
  type MachineRecord,
  type MachineWithAgentsRecord,
  normalizeMachineRuntimes,
  updateMachine,
  updateMachineAmaEnvironment,
  upsertMachine,
  upsertNativeMachine,
} from "./machineRepo";
import { createMailbox, deleteMailbox, getEmail, getInbox } from "./mailsService";
import { createMessage, listMessages } from "./messageRepo";
import { metricsMiddleware } from "./metrics";
import { getMachineMetrics } from "./metricsRepo";
import { listRuntimeModels } from "./modelCatalog";
import { AK_SCOPES, beginRealmrootLogin, endRealmrootWebSession, finishRealmrootLogin, readRealmrootWebSession, resourceUrl } from "./realmrootAuth";
import { createRepository, deleteRepository, getRepository, listRepositories, normalizeGitUrl } from "./repositoryRepo";
import { metadataWithRuntimeSource, taskRuntimeSource } from "./runtimeBinding";
import { dispatchAssignedTask, releaseAssignedTaskRuntime, resolveAssignableWorkerRuntimeSource } from "./runtimeCoordinator";
import { amaRunnerHeartbeatFresh, listAvailableRuntimeSources } from "./runtimeRouter";
import { createSSEResponse } from "./sse";
import { getSystemStats } from "./statsRepo";
import { createSubagent, deleteSubagent, getSubagent, listSubagents, updateSubagent } from "./subagentRepo";
import {
  amaRuntimeName,
  amaRuntimeSecretEnvForCredentialNames,
  apiUrl,
  boardMaintainerHttpTriggerName,
  boardMaintainerResourceName,
  boardMaintainerScheduleTriggerName,
  createAmaAgentForAkProfile,
  ensureAmaAgentForAkAgent,
  sendTaskMessageToAma,
  sendTaskRejectToAma,
  syncAmaAgentForAkProfile,
  USER_VARIABLES_CREDENTIAL_NAME,
} from "./taskDispatch";
import {
  addTaskAction,
  assertTaskOwner,
  assignTask,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  deleteTask,
  deleteTaskAfterFailedDispatch,
  finalizeTaskAssignment,
  getTask,
  getTaskActions,
  listTasks,
  rejectTask,
  releaseTask,
  reviewTask,
  rollbackTaskAssignment,
  updateTask,
} from "./taskRepo";
import type { Env } from "./types";

const api = new Hono<{ Bindings: Env }>();
const logger = createLogger("api");

function markLegacyRuntimeSurface(c: { header: (name: string, value: string) => void }) {
  c.header("Deprecation", "true");
  c.header("Sunset", "2026-09-01T00:00:00Z");
  c.header("X-AK-Runtime-Surface", "legacy-daemon");
}

const SUBAGENT_RUNTIMES = new Set(["claude", "codex", "copilot"]);

function assertValidSkillRefs(skills: unknown) {
  if (skills === undefined) return;
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string")) {
    throw new HTTPException(400, { message: "skills must be an array of source/repo[#ref]@skill-name strings" });
  }
  const invalid = findInvalidSkillRef(skills);
  if (invalid) {
    throw new HTTPException(400, { message: `Invalid skill "${invalid}". Use source/repo[#ref]@skill-name format.` });
  }
}

function assertValidAgentTaints(taints: unknown) {
  if (taints === undefined) return;
  if (!Array.isArray(taints)) {
    throw new HTTPException(400, { message: "taints must be an array" });
  }
  for (const taint of taints) {
    if (!taint || typeof taint !== "object" || Array.isArray(taint)) {
      throw new HTTPException(400, { message: "taints must be an array of objects" });
    }
    const { key, value, effect } = taint as Record<string, unknown>;
    if (typeof key !== "string" || key.trim().length === 0 || key.length > 253) {
      throw new HTTPException(400, { message: "taint key must be a non-empty string up to 253 characters" });
    }
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new HTTPException(400, { message: "taint value must be a string or null" });
    }
    if (effect !== "NoSchedule") {
      throw new HTTPException(400, { message: "taint effect must be NoSchedule" });
    }
  }
}

function assertJsonObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HTTPException(400, { message: `${name} must be a JSON object` });
  }
}

function assertSubagentList(subagents: unknown) {
  if (subagents === undefined) return;
  if (!Array.isArray(subagents) || subagents.some((agent) => typeof agent !== "string" || agent.length === 0)) {
    throw new HTTPException(400, { message: "subagents must be an array of subagent IDs" });
  }
}

function assertModels(models: unknown) {
  if (models === undefined || models === null) return;
  assertJsonObject(models, "models");
  for (const [runtime, model] of Object.entries(models)) {
    if (!AGENT_RUNTIMES.includes(runtime as any)) {
      throw new HTTPException(400, { message: `Invalid models key "${runtime}". Must be one of: ${AGENT_RUNTIMES.join(", ")}` });
    }
    if (typeof model !== "string" || model.length === 0) {
      throw new HTTPException(400, { message: `models.${runtime} must be a non-empty model string` });
    }
  }
}

function assertValidAgentRole(role: unknown): void {
  if (role === undefined || role === null) return;
  if (typeof role !== "string" || !isValidAgentRole(role)) {
    throw new HTTPException(400, { message: "role must be kebab-case: lowercase letters, numbers, and single hyphens; start with a letter" });
  }
}

function assertValidHandoffRoles(roles: unknown): void {
  if (roles === undefined || roles === null) return;
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string" || !isValidAgentRole(role))) {
    throw new HTTPException(400, { message: "handoff_to must be an array of kebab-case agent roles" });
  }
}

function assertSubagentRuntime(runtime: string, subagents: string[] | null | undefined) {
  if (!subagents || subagents.length === 0) return;
  if (!SUBAGENT_RUNTIMES.has(runtime)) {
    throw new HTTPException(400, { message: `Runtime "${runtime}" does not support subagents yet` });
  }
}

function assertValidAgentRuntime(runtime: string | undefined, kind: "worker" | "leader" = "worker"): void {
  if (runtime === undefined) return;
  const runtimes = kind === "leader" ? LEADER_AGENT_RUNTIMES : AGENT_RUNTIMES;
  if (!runtimes.includes(runtime as never)) {
    throw new HTTPException(400, { message: `Invalid ${kind} runtime "${runtime}". Must be one of: ${runtimes.join(", ")}` });
  }
}

function assertKnownAgentRuntime(runtime: string | undefined): void {
  if (runtime === undefined) return;
  if (![...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES].includes(runtime as never)) {
    throw new HTTPException(400, {
      message: `Invalid runtime "${runtime}". Must be one of: ${[...new Set([...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES])].join(", ")}`,
    });
  }
}

function withRuntimeSource<T extends Record<string, any>>(env: Env, agent: T, availableRuntimes?: Set<string>): T {
  if (!isAmaTaskDispatchConfigured(env)) return agent;
  if (availableRuntimes === undefined) return agent;
  return withAgentStatus(agent as any, availableRuntimes.has(agent.runtime)) as unknown as T;
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HTTPException(400, { message: `${name} must be true or false` });
}

function assertValidAgentKind(value: unknown): asserts value is "worker" | "leader" | undefined {
  if (value === undefined) return;
  if (value === "worker" || value === "leader") return;
  throw new HTTPException(400, { message: "kind must be worker or leader" });
}

function parseOptionalAgentKind(value: string | undefined): "worker" | "leader" | undefined {
  if (value === undefined) return undefined;
  assertValidAgentKind(value);
  return value;
}

function normalizeTaskDetailAlias(body: Record<string, any>) {
  if (body.detail === undefined) return;
  if (typeof body.detail !== "string") {
    throw new HTTPException(400, { message: "detail must be a string" });
  }
  if (body.description === undefined) {
    body.description = body.detail;
  }
  delete body.detail;
}

async function assertRegisteredSubagents(
  db: Env["DB"],
  ownerId: string,
  subagents: string[] | null | undefined,
  currentAgentId?: string,
): Promise<void> {
  if (!subagents || subagents.length === 0) return;
  const ids = [...new Set(subagents)];
  if (currentAgentId && ids.includes(currentAgentId)) {
    throw new HTTPException(400, { message: "Agent cannot include itself as a subagent" });
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT id FROM subagents WHERE owner_id = ? AND id IN (${placeholders})`)
    .bind(ownerId, ...ids)
    .all<{ id: string }>();
  const found = new Map(result.results.map((agent) => [agent.id, agent]));
  for (const id of ids) {
    if (!found.has(id)) throw new HTTPException(400, { message: `Subagent "${id}" is not registered` });
  }
}

async function assertSubagentNotReferenced(db: Env["DB"], ownerId: string, subagentId: string): Promise<void> {
  const row = await db
    .prepare(`
      SELECT a.name
      FROM agents a, json_each(a.subagents) ref
      WHERE a.owner_id = ? AND ref.value = ?
      LIMIT 1
    `)
    .bind(ownerId, subagentId)
    .first<{ name: string }>();
  if (row) throw new HTTPException(409, { message: `Subagent is referenced by agent "${row.name}"` });
}

function assertValidMachineRuntimes(runtimes: unknown): void {
  if (!Array.isArray(runtimes)) {
    throw new HTTPException(400, { message: "runtimes must be an array" });
  }
  try {
    normalizeMachineRuntimes(runtimes as MachineRuntime[], new Date().toISOString());
  } catch (err) {
    throw new HTTPException(400, { message: err instanceof Error ? err.message : "Invalid runtimes" });
  }
}

function readyAmaRuntimeNames(runtimes: MachineRuntime[]): string[] {
  return runtimes.filter((runtime) => runtime.status === "ready").map((runtime) => amaRuntimeName(runtime.name));
}

function validateMaintainerHeartbeatInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS) {
    throw new HTTPException(400, {
      message: `interval_seconds must be an integer >= ${MAINTAINER_HEARTBEAT_MIN_INTERVAL_SECONDS}`,
    });
  }
}

function validateMaintainerHeartbeatEnabled(heartbeatEnabled: unknown): void {
  if (heartbeatEnabled !== undefined && typeof heartbeatEnabled !== "boolean") {
    throw new HTTPException(400, { message: "heartbeat_enabled must be a boolean" });
  }
}

function maintainerScheduledStatus(status: "active" | "paused", heartbeatEnabled: boolean): "active" | "paused" {
  return status === "active" && heartbeatEnabled ? "active" : "paused";
}

function publicBoardMaintainer(
  maintainer: BoardMaintainer,
): Omit<
  BoardMaintainer,
  | "ama_schedule_id"
  | "ama_http_trigger_id"
  | "ama_http_trigger_serialized"
  | "ama_http_trigger_serialization_attempted_at"
  | "ama_memory_store_id"
  | "ama_board_vault_id"
  | "last_ama_session_id"
  | "prompt"
> {
  const {
    ama_schedule_id: _scheduleId,
    ama_http_trigger_id: _httpTriggerId,
    ama_http_trigger_serialized: _httpTriggerSerialized,
    ama_http_trigger_serialization_attempted_at: _httpTriggerSerializationAttemptedAt,
    ama_memory_store_id: _memoryStoreId,
    ama_board_vault_id: _boardVaultId,
    last_ama_session_id: _lastAmaSessionId,
    prompt: _prompt,
    ...publicMaintainer
  } = maintainer;
  return publicMaintainer;
}

async function publicBoardMaintainerWithAmaStatus(db: D1, env: Env, ownerId: string, maintainer: BoardMaintainer) {
  const publicMaintainer = publicBoardMaintainer(maintainer);
  if (!isAmaTaskDispatchConfigured(env)) return publicMaintainer;

  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) return publicMaintainer;
  const latestRun = await latestMaintainerRun(env, ownerId, projectId, maintainer);
  return {
    ...publicMaintainer,
    last_run_at: maintainerRunTimestamp(latestRun) ?? publicMaintainer.last_run_at,
    last_session_id: latestRun?.sessionId ?? null,
    last_error_message: latestRun?.errorMessage ?? null,
    latest_run: latestRun ? publicMaintainerRun(latestRun) : null,
  };
}

async function listPublicMaintainersWithAmaStatus(db: D1, env: Env, ownerId: string, maintainers: BoardMaintainer[]) {
  return await Promise.all(maintainers.map((maintainer) => publicBoardMaintainerWithAmaStatus(db, env, ownerId, maintainer)));
}

async function availableRuntimeNames(db: D1, env: Env, ownerId: string): Promise<Set<string>> {
  const sources = await listAvailableRuntimeSources(db, env, ownerId);
  return new Set([...sources].filter(([, availability]) => availability.ama || availability.legacy).map(([runtime]) => runtime));
}

// Idempotently initializes the tenant's AMA resources through AK's global
// Machine Application. No user token or account connection is involved.
async function requireAmaConnected(db: D1, env: Env, ownerId: string): Promise<void> {
  if (!isAmaTaskDispatchConfigured(env)) return;
  await ensureAmaOwnerIntegration(db, env, ownerId);
}

async function latestMaintainerRun(env: Env, ownerId: string, projectId: string, maintainer: BoardMaintainer) {
  const triggerIds = [maintainer.ama_schedule_id, maintainer.ama_http_trigger_id].filter((id): id is string => Boolean(id));
  const pages = await Promise.all(triggerIds.map((triggerId) => listAmaTriggerRuns(env, ownerId, projectId, triggerId, { limit: 1 })));
  return pages.flatMap((page) => page.data).sort((a, b) => (maintainerRunTimestamp(b) ?? "").localeCompare(maintainerRunTimestamp(a) ?? ""))[0];
}

function maintainerRunTimestamp(run: { heartbeatAt: string | null; triggeredAt?: string | null; createdAt?: string } | undefined): string | null {
  return run?.heartbeatAt ?? run?.triggeredAt ?? run?.createdAt ?? null;
}

function publicMaintainerRun(run: {
  id: string;
  triggerId?: string;
  scheduledFor: string | null;
  heartbeatAt: string | null;
  triggeredAt?: string | null;
  status: string;
  sessionId: string | null;
  errorMessage: string | null;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}) {
  return {
    id: run.id,
    scheduled_for: run.scheduledFor,
    heartbeat_at: run.heartbeatAt,
    triggered_at: run.triggeredAt ?? null,
    status: run.status,
    session_id: run.sessionId,
    error_message: run.errorMessage,
    metadata: run.metadata ?? {},
    ...(run.createdAt ? { created_at: run.createdAt } : {}),
    ...(run.updatedAt ? { updated_at: run.updatedAt } : {}),
  };
}

function publicMaintainerMemory(memory: {
  id: string;
  path: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: memory.id,
    path: memory.path,
    content: memory.content,
    metadata: memory.metadata ?? {},
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  };
}

function publicMachine<T extends MachineRecord | MachineWithAgentsRecord>(machine: T): Omit<T, "ama_environment_id"> {
  const { ama_environment_id: _environmentId, ...publicMachine } = machine;
  return publicMachine;
}

async function machineWithAmaRunnerStatus<T extends MachineRecord | MachineWithAgentsRecord>(
  env: Env,
  ownerId: string,
  projectId: string,
  machine: T,
): Promise<T> {
  if (!machine.ama_environment_id) {
    return machineWithLegacyRuntimeStatus(machine);
  }
  const runners = await listAmaRunners(env, ownerId, projectId, machine.ama_environment_id);
  const activeRunners = runners.data.filter((runner) => runner.status === "active" && amaRunnerHeartbeatFresh(runner));
  if (activeRunners.length === 0 && legacyMachineHeartbeatFresh(machine)) {
    return {
      ...machine,
      runner_count: runners.data.length,
      active_runner_count: 0,
      runner_capacity: 0,
    };
  }
  const activeLoad = activeRunners.reduce((sum, runner) => sum + runner.currentLoad, 0);
  const amaHeartbeatAt = activeRunners
    .map((runner) => runner.lastHeartbeatAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1);
  const lastHeartbeatAt = [amaHeartbeatAt, legacyMachineHeartbeatFresh(machine) ? machine.last_heartbeat_at : null]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const amaRuntimes = machineRuntimesFromAmaRunners(activeRunners, amaHeartbeatAt ?? new Date().toISOString());
  return {
    ...machine,
    status: activeRunners.length > 0 ? "online" : "offline",
    last_heartbeat_at: lastHeartbeatAt ?? null,
    runtimes: mergeLegacyMachineRuntimes(machine, amaRuntimes),
    usage_info: machineUsageInfoFromRunners(runners.data) ?? machine.usage_info,
    runner_count: runners.data.length,
    active_runner_count: activeRunners.length,
    runner_capacity: activeRunners.reduce((sum, runner) => sum + runner.maxConcurrent, 0),
    ...("active_session_count" in machine ? { active_session_count: activeLoad } : {}),
  };
}

function mergeLegacyMachineRuntimes<T extends MachineRecord | MachineWithAgentsRecord>(machine: T, amaRuntimes: MachineRuntime[]): MachineRuntime[] {
  if (!legacyMachineHeartbeatFresh(machine)) return amaRuntimes;
  const amaNames = new Set(amaRuntimes.map((runtime) => runtime.name));
  return [...amaRuntimes, ...machine.runtimes.filter((runtime) => !amaNames.has(runtime.name))];
}

function machineWithLegacyRuntimeStatus<T extends MachineRecord | MachineWithAgentsRecord>(machine: T): T {
  if (legacyMachineHeartbeatFresh(machine)) return machine;
  return { ...machine, status: "offline", last_heartbeat_at: null, runtimes: [] };
}

function machineRuntimesFromAmaRunners(runners: AmaRunner[], checkedAt: string): MachineRuntime[] {
  const byRuntime = new Map<AgentRuntime, MachineRuntime>();
  for (const runner of runners) {
    for (const entry of runner.runtimes) {
      const runtime = akRuntimeFromAmaRuntime(entry.runtime);
      const status = machineRuntimeStatusFromAmaState(entry.state);
      if (!runtime || !status) continue;
      mergeMachineRuntime(byRuntime, {
        name: runtime,
        status,
        ...(entry.detail ? { detail: entry.detail } : {}),
        checked_at: checkedAt,
      });
    }
  }
  return AGENT_RUNTIMES.flatMap((runtime) => {
    const entry = byRuntime.get(runtime);
    return entry ? [entry] : [];
  });
}

function mergeMachineRuntime(runtimes: Map<AgentRuntime, MachineRuntime>, next: MachineRuntime): void {
  const current = runtimes.get(next.name);
  if (!current || machineRuntimeStatusRank(next.status) > machineRuntimeStatusRank(current.status)) {
    runtimes.set(next.name, next);
  }
}

function machineRuntimeStatusRank(status: MachineRuntime["status"]): number {
  if (status === "ready") return 5;
  if (status === "limited") return 4;
  if (status === "unauthorized") return 3;
  if (status === "unhealthy") return 2;
  return 1;
}

function machineRuntimeStatusFromAmaState(state: string): MachineRuntime["status"] | null {
  if (state === "ready" || state === "limited" || state === "missing" || state === "unauthorized" || state === "unhealthy") return state;
  if (state === "unauthenticated") return "unauthorized";
  return null;
}

function akRuntimeFromAmaRuntime(runtime: string): AgentRuntime | null {
  if (runtime === "claude-code") return "claude";
  if (runtime === "codex" || runtime === "copilot") return runtime;
  return null;
}

function machineUsageInfoFromRunners(runners: AmaRunner[]): UsageInfo | null {
  const windows: UsageWindow[] = [];
  let updatedAt = "";
  for (const runner of runners) {
    for (const usage of runner.runtimeUsage ?? []) {
      const runtime = akRuntimeFromAmaRuntime(usage.runtime);
      if (!runtime) continue;
      for (const window of usage.windows) {
        windows.push({ runtime, label: window.label, utilization: window.utilization, resets_at: window.resetsAt });
      }
    }
    if (runner.lastHeartbeatAt && runner.lastHeartbeatAt > updatedAt) updatedAt = runner.lastHeartbeatAt;
  }
  if (windows.length === 0) return null;
  return { windows, updated_at: updatedAt || new Date().toISOString() };
}

async function machinesWithRuntimeStatus<T extends MachineRecord | MachineWithAgentsRecord>(
  db: D1,
  env: Env,
  ownerId: string,
  machines: T[],
): Promise<T[]> {
  if (!isAmaTaskDispatchConfigured(env)) {
    return machines;
  }
  if (machines.every((machine) => !machine.ama_environment_id)) {
    return machines.map(machineWithLegacyRuntimeStatus);
  }
  const projectId = await getAmaProjectId(db, ownerId);
  if (!projectId) {
    return machines.map(machineWithLegacyRuntimeStatus);
  }
  return await Promise.all(machines.map((machine) => machineWithAmaRunnerStatus(env, ownerId, projectId, machine)));
}

async function machinesWithRuntimeStatusByOwner<T extends MachineRecord | MachineWithAgentsRecord>(db: D1, env: Env, machines: T[]): Promise<T[]> {
  if (!isAmaTaskDispatchConfigured(env)) {
    return machines;
  }
  const projectIds = new Map<string, string>();
  return await Promise.all(
    machines.map(async (machine) => {
      if (!machine.ama_environment_id) {
        return machineWithLegacyRuntimeStatus(machine);
      }
      let projectId = projectIds.get(machine.owner_id);
      if (projectId === undefined) {
        projectId = (await getAmaProjectId(db, machine.owner_id)) ?? "";
        projectIds.set(machine.owner_id, projectId);
      }
      if (!projectId) {
        return machineWithLegacyRuntimeStatus(machine);
      }
      return await machineWithAmaRunnerStatus(env, machine.owner_id, projectId, machine);
    }),
  );
}

async function ensureMachineAmaEnvironment(db: D1, env: Env, ownerId: string, machine: MachineRecord): Promise<string> {
  const binding = await ensureAmaOwnerIntegration(db, env, ownerId);
  // Validate the stored environment still exists. An AMA data reset (or a
  // re-provisioned project) leaves the id dangling, which makes the runner's
  // registration fail with "Runner environment is unavailable"; recreate it.
  if (machine.ama_environment_id && (await amaEnvironmentExists(env, ownerId, binding.amaProjectId, machine.ama_environment_id))) {
    return machine.ama_environment_id;
  }
  const environment = await createAmaEnvironment(env, ownerId, {
    projectId: binding.amaProjectId,
    name: machine.name,
    description: `Self-hosted environment for AK machine ${machine.id}.`,
    hostingMode: "self_hosted",
    metadata: { machineId: machine.id },
  });
  return environment.id;
}

// The self-hosted runner authenticates itself (Realmroot Context login against AMA); AK no
// longer mints a federated runner token. Onboarding just hands the runner the
// AMA origin and the project/environment it should join.
async function createMachineRunnerOnboarding(env: Env, machine: MachineRecord, ownerId: string) {
  const environmentId = machine.ama_environment_id;
  if (!environmentId) return null;
  if (readyAmaRuntimeNames(machine.runtimes).length === 0) return null;

  const projectId = await resolveAmaProjectId(env.DB, env, ownerId);

  return {
    origin: env.AMA_ORIGIN,
    projectId,
    environmentId,
    // Server-pinned runner version: lets the control plane roll the runner
    // forward without a CLI release. Absent → the CLI falls back to its pin.
    version: env.AMA_RUNNER_VERSION ?? null,
  };
}

function resolveActor(c: { get: (key: string) => any }): { actorType: string; actorId: string; sessionId: string | null } {
  const identity: string = c.get("identityType") || "machine";
  let actorId: string;
  if (identity === "user") actorId = c.get("ownerId") || "unknown";
  else if (identity === "machine") actorId = c.get("machineId") || c.get("principal")?.subjectId || "unknown";
  else actorId = c.get("agentId") || "unknown";
  const sessionId: string | null = c.get("sessionId") || null;
  return { actorType: identity, actorId, sessionId };
}

function taskIdentity(c: { get: (key: string) => any }): TaskIdentityType {
  const identity = c.get("identityType");
  if (identity === "maintainer:key") throw new HTTPException(403, { message: "Agent session required" });
  return identity;
}

async function taskManagementIdentity(c: { env: Env; get: (key: string) => any }, task: Pick<Task, "board_id">): Promise<TaskIdentityType> {
  const identity = taskIdentity(c);
  if (identity !== "agent:worker") return identity;

  const agentId = c.get("agentId");
  if (agentId && (await isActiveMaintainerForBoard(c.env.DB, c.get("ownerId"), agentId, task.board_id))) {
    return "agent:maintainer";
  }

  return identity;
}

async function requireTaskManager(c: { env: Env; get: (key: string) => any }, task: Pick<Task, "board_id">): Promise<TaskIdentityType> {
  const identity = await taskManagementIdentity(c, task);
  if (identity === "agent:worker") {
    throw new HTTPException(403, { message: "Active board maintainer or leader identity required" });
  }
  return identity;
}

async function isCurrentTaskWorkerForRepository(
  db: D1,
  ownerId: string,
  agentId: string,
  sessionId: string | null,
  repositoryId: string,
): Promise<boolean> {
  if (!sessionId) return false;
  const row = await db
    .prepare(
      `
      SELECT t.id FROM tasks t
      JOIN boards b ON b.id = t.board_id
      WHERE b.owner_id = ?
        AND t.repository_id = ?
        AND t.assigned_to = ?
        AND t.status IN ('todo', 'in_progress', 'in_review')
        AND json_extract(t.metadata, '$.annotations."agentSessionId"') = ?
      LIMIT 1
    `,
    )
    .bind(ownerId, repositoryId, agentId, sessionId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function validateTaskManagementTransition(
  c: { env: Env; get: (key: string) => any },
  action: "complete" | "release" | "cancel" | "reject",
  task: Pick<Task, "board_id" | "status">,
): Promise<TaskIdentityType> {
  const identity = await taskManagementIdentity(c, task);
  const transitionError = validateTransition(action, task.status, identity);
  if (transitionError) {
    throw new HTTPException(transitionError.code === "FORBIDDEN" ? 403 : 409, { message: transitionError.message });
  }
  return identity;
}

// Access log
api.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const status = c.res.status;
  if (status >= 400) {
    logger.warn(`${c.req.method} ${c.req.path} ${status} ${Date.now() - start}ms`);
  }
});

// Error handler
api.onError((err, c) => {
  if (err instanceof AmaUserAuthError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: err.message, message: err.message } }, err.status);
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  const causeDetail = cause instanceof Error ? ` cause=${cause.message}` : cause === undefined ? "" : ` cause=${String(cause)}`;
  logger.error(`${c.req.method} ${c.req.path} 500 ${err.message}${causeDetail} ${err.stack}`);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
});

api.get("/api/auth/login", beginRealmrootLogin);
api.get("/api/auth/callback", finishRealmrootLogin);
api.get("/api/auth/session", readRealmrootWebSession);
api.post("/api/auth/logout", endRealmrootWebSession);

api.get("/.well-known/oauth-protected-resource/api", (c) =>
  c.json({
    resource: resourceUrl(c.env, c.req.url),
    resource_name: "Agent Kanban API",
    authorization_servers: [c.env.REALMROOT_ISSUER.replace(/\/$/, "")],
    scopes_supported: [...AK_SCOPES],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
    dpop_bound_access_tokens_required: false,
  }),
);

api.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: resourceUrl(c.env, c.req.url),
    resource_name: "Agent Kanban API",
    authorization_servers: [c.env.REALMROOT_ISSUER.replace(/\/$/, "")],
    scopes_supported: [...AK_SCOPES],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: ["ES256"],
    dpop_bound_access_tokens_required: false,
  }),
);

api.get("/api", (c) =>
  c.json({ name: "Agent Kanban", resource: resourceUrl(c.env, c.req.url), openapi: new URL("/api/openapi.json", c.req.url).toString() }, 200, {
    Link: `<${new URL("/api/openapi.json", c.req.url)}>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1"`,
  }),
);

type OpenApiAuth = "realmroot" | "agent" | "either";
const AMA_PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

function taskActionOpenApi(operationId: string, scope: string, auth: OpenApiAuth) {
  return {
    parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
    post: openApiOperation(operationId, scope, "Task transition accepted", "200", auth),
  };
}

function openApiOperation(operationId: string, scope: string, description: string, status = "200", auth: OpenApiAuth = "realmroot") {
  const security =
    auth === "realmroot" ? [{ realmroot: [scope] }] : auth === "agent" ? [{ agentSession: [] }] : [{ realmroot: [scope] }, { agentSession: [] }];
  return { operationId, security, responses: { [status]: { description } } };
}

function openApiPathParameter(name: string) {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

api.get("/api/openapi.json", (c) =>
  c.json({
    openapi: "3.1.0",
    info: { title: "Agent Kanban API", version: "1.0.0" },
    servers: [{ url: resourceUrl(c.env, c.req.url) }],
    components: {
      securitySchemes: {
        realmroot: {
          type: "openIdConnect",
          openIdConnectUrl: `${c.env.REALMROOT_ISSUER.replace(/\/$/, "")}/.well-known/openid-configuration`,
          "x-resource": resourceUrl(c.env, c.req.url),
          description: "Realmroot access token for the exact AK Resource. Bearer and sender-constrained DPoP credentials are accepted.",
          "x-token-types": ["Bearer", "DPoP"],
        },
        agentSession: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "agent+jwt",
          description: "Short-lived Ed25519 AK Agent Session token issued for an active AK Agent runtime session.",
        },
        webSession: {
          type: "apiKey",
          in: "cookie",
          name: "ak_session",
          description: "Opaque AK Web Session cookie. Browser WebSocket clients must also send the canonical AK Origin.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } },
          },
        },
      },
      parameters: {
        AkMachineContext: {
          name: "X-AK-Machine-ID",
          in: "header",
          required: false,
          description: "AK machine registered to a human Realmroot Native subject; required for local runtime operations made with a human token",
          schema: { type: "string" },
        },
      },
    },
    security: [{ realmroot: [] }],
    paths: {
      "/tasks": {
        get: openApiOperation("listTasks", "ak:read", "Tasks visible to the tenant", "200", "either"),
        post: openApiOperation("createTask", "task:log", "Task created", "201", "agent"),
      },
      "/tasks/{taskId}": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("getTask", "ak:read", "Task", "200", "either"),
        patch: openApiOperation("updateTask", "task:log", "Task updated", "200", "agent"),
        delete: openApiOperation("deleteTask", "task:cancel", "Task deleted", "200", "agent"),
      },
      "/tasks/{taskId}/claim": taskActionOpenApi("claimTask", "task:claim", "agent"),
      "/tasks/{taskId}/assign": taskActionOpenApi("assignTask", "task:assign", "agent"),
      "/tasks/{taskId}/release": taskActionOpenApi("releaseTask", "task:release", "either"),
      "/tasks/{taskId}/review": taskActionOpenApi("reviewTask", "task:review", "agent"),
      "/tasks/{taskId}/complete": taskActionOpenApi("completeTask", "task:complete", "either"),
      "/tasks/{taskId}/reject": taskActionOpenApi("rejectTask", "task:reject", "either"),
      "/tasks/{taskId}/cancel": taskActionOpenApi("cancelTask", "task:cancel", "either"),
      "/tasks/{taskId}/notes": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("listTaskNotes", "ak:read", "Task notes", "200", "either"),
        post: openApiOperation("addTaskNote", "task:log", "Task note created", "201", "agent"),
      },
      "/tasks/{taskId}/messages": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("listTaskMessages", "ak:read", "Task messages", "200", "either"),
        post: openApiOperation("createTaskMessage", "task:message", "Task message created", "201", "either"),
      },
      "/tasks/{taskId}/session": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("getTaskSession", "ak:read", "Task runtime session", "200", "either"),
      },
      "/tasks/{taskId}/session/ws": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("getTaskSessionSocket", "ak:read", "Task runtime socket descriptor", "200", "either"),
      },
      "/tasks/{taskId}/stream": {
        parameters: [openApiPathParameter("taskId")],
        get: openApiOperation("streamTask", "ak:read", "Task Server-Sent Events stream", "200", "either"),
      },
      "/sessions": { get: openApiOperation("listSessions", "ak:read", "Runtime sessions", "200", "either") },
      "/sessions/{sessionId}": {
        parameters: [openApiPathParameter("sessionId")],
        get: openApiOperation("getSession", "ak:read", "Runtime session", "200", "either"),
      },
      "/sessions/{sessionId}/ws": {
        parameters: [openApiPathParameter("sessionId")],
        get: openApiOperation("getSessionSocket", "ak:read", "Runtime socket descriptor", "200", "either"),
      },
      "/agents": {
        get: openApiOperation("listAgents", "ak:read", "AK-managed Agents", "200", "either"),
        post: openApiOperation("createAgent", "ak:write", "AK-managed Agent created", "201", "either"),
      },
      "/agents/{agentId}": {
        parameters: [openApiPathParameter("agentId")],
        get: openApiOperation("getAgent", "ak:read", "AK-managed Agent", "200", "either"),
        patch: openApiOperation("updateAgent", "ak:write", "Agent updated", "200", "either"),
        delete: openApiOperation("deleteAgent", "ak:write", "Agent deleted", "200", "either"),
      },
      "/agents/{agentId}/sessions": {
        parameters: [openApiPathParameter("agentId")],
        get: openApiOperation("listAgentSessions", "ak:read", "Agent sessions", "200", "either"),
        post: {
          ...openApiOperation("createAgentSession", "ak:write", "Agent session created", "201"),
          parameters: [{ $ref: "#/components/parameters/AkMachineContext" }],
        },
      },
      "/agents/{agentId}/sessions/{sessionId}": {
        parameters: [openApiPathParameter("agentId"), openApiPathParameter("sessionId")],
        delete: openApiOperation("closeAgentSession", "ak:write", "Agent session closed"),
      },
      "/agents/{agentId}/sessions/{sessionId}/reopen": {
        parameters: [openApiPathParameter("agentId"), openApiPathParameter("sessionId")],
        post: openApiOperation("reopenAgentSession", "ak:write", "Agent session reopened"),
      },
      "/agents/{agentId}/sessions/{sessionId}/usage": {
        parameters: [openApiPathParameter("agentId"), openApiPathParameter("sessionId")],
        patch: openApiOperation("updateAgentSessionUsage", "agent:usage", "Agent usage updated", "200", "either"),
      },
      "/agents/{agentId}/inbox": {
        parameters: [openApiPathParameter("agentId")],
        get: openApiOperation("listAgentInbox", "ak:read", "Agent inbox"),
      },
      "/agents/{agentId}/inbox/{messageId}": {
        parameters: [openApiPathParameter("agentId"), openApiPathParameter("messageId")],
        get: openApiOperation("getAgentInboxMessage", "ak:read", "Agent inbox message"),
      },
      "/subagents": {
        get: openApiOperation("listSubagents", "ak:read", "Subagents", "200", "either"),
        post: openApiOperation("createSubagent", "ak:write", "Subagent created", "201", "either"),
      },
      "/subagents/{subagentId}": {
        parameters: [openApiPathParameter("subagentId")],
        get: openApiOperation("getSubagent", "ak:read", "Subagent", "200", "either"),
        patch: openApiOperation("updateSubagent", "ak:write", "Subagent updated", "200", "either"),
        delete: openApiOperation("deleteSubagent", "ak:write", "Subagent deleted", "200", "either"),
      },
      "/machines": {
        get: openApiOperation("listMachines", "ak:read", "Machines"),
        post: openApiOperation("registerMachine", "ak:write", "Machine registered", "201"),
      },
      "/machines/{machineId}": {
        parameters: [openApiPathParameter("machineId")],
        get: openApiOperation("getMachine", "ak:read", "Machine"),
        delete: openApiOperation("deleteMachine", "ak:write", "Machine deleted"),
      },
      "/machines/{machineId}/heartbeat": {
        parameters: [openApiPathParameter("machineId"), { $ref: "#/components/parameters/AkMachineContext" }],
        post: openApiOperation("heartbeatMachine", "ak:write", "Machine heartbeat accepted"),
      },
      "/machines/cloud": { post: openApiOperation("createCloudMachine", "ak:write", "Cloud machine created", "201") },
      "/ama/provision": { post: openApiOperation("initializeAmaResources", "ak:write", "AMA resources initialized") },
      "/ama/sessions/{sessionId}/socket": {
        parameters: [
          openApiPathParameter("sessionId"),
          {
            name: "projectId",
            in: "query",
            required: false,
            description: "AMA project that owns the session. Omit only for sessions in the tenant's current AMA project.",
            schema: { type: "string", minLength: 1, maxLength: 160, pattern: AMA_PROJECT_ID_PATTERN.source },
          },
        ],
        get: {
          operationId: "proxyAmaSessionSocket",
          security: [{ webSession: [] }, { realmroot: ["ak:read"] }, { agentSession: [] }],
          responses: {
            "101": { description: "WebSocket connection established" },
            "400": { description: "Invalid AMA project ID" },
            "403": { description: "AK user or Agent authority required; browser Sessions also require the canonical Origin" },
            "404": { description: "AMA session not found in the requested project" },
            "426": { description: "WebSocket upgrade required" },
          },
        },
      },
      "/models": { get: openApiOperation("listModels", "ak:read", "Runtime models", "200", "either") },
      "/boards": {
        get: openApiOperation("listBoards", "ak:read", "Boards", "200", "either"),
        post: openApiOperation("createBoard", "ak:write", "Board created", "201", "either"),
      },
      "/boards/{boardId}": {
        parameters: [openApiPathParameter("boardId")],
        get: openApiOperation("getBoard", "ak:read", "Board", "200", "either"),
        patch: openApiOperation("updateBoard", "ak:write", "Board updated", "200", "either"),
        delete: openApiOperation("deleteBoard", "ak:write", "Board deleted", "200", "either"),
      },
      "/boards/{boardId}/labels": {
        parameters: [openApiPathParameter("boardId")],
        post: openApiOperation("createBoardLabel", "ak:write", "Board label created", "201", "either"),
      },
      "/boards/{boardId}/labels/{labelName}": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("labelName")],
        patch: openApiOperation("updateBoardLabel", "ak:write", "Board label updated", "200", "either"),
        delete: openApiOperation("deleteBoardLabel", "ak:write", "Board label deleted", "200", "either"),
      },
      "/boards/{boardId}/maintainers": {
        parameters: [openApiPathParameter("boardId")],
        get: openApiOperation("listBoardMaintainers", "ak:read", "Board maintainers", "200", "either"),
        post: openApiOperation("createBoardMaintainer", "ak:write", "Board maintainer created", "201", "either"),
      },
      "/boards/{boardId}/maintainers/{maintainerId}": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("maintainerId")],
        get: openApiOperation("getBoardMaintainer", "ak:read", "Board maintainer", "200", "either"),
        patch: openApiOperation("updateBoardMaintainer", "ak:write", "Board maintainer updated", "200", "either"),
        delete: openApiOperation("deleteBoardMaintainer", "ak:write", "Board maintainer deleted", "200", "either"),
      },
      "/boards/{boardId}/maintainers/{maintainerId}/runs": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("maintainerId")],
        get: openApiOperation("listBoardMaintainerRuns", "ak:read", "Board maintainer runs", "200", "either"),
      },
      "/boards/{boardId}/maintainers/{maintainerId}/variables": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("maintainerId")],
        get: openApiOperation("listMaintainerVariables", "ak:read", "Maintainer variables", "200", "either"),
        put: openApiOperation("replaceMaintainerVariables", "ak:write", "Maintainer variables replaced", "200", "either"),
      },
      "/boards/{boardId}/maintainers/{maintainerId}/sessions": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("maintainerId")],
        post: openApiOperation("createMaintainerSession", "ak:write", "Maintainer session created", "201", "agent"),
      },
      "/boards/{boardId}/maintainers/{maintainerId}/memories": {
        parameters: [openApiPathParameter("boardId"), openApiPathParameter("maintainerId")],
        get: openApiOperation("listMaintainerMemories", "ak:read", "Maintainer memories", "200", "either"),
      },
      "/boards/{boardId}/stream": {
        parameters: [openApiPathParameter("boardId")],
        get: openApiOperation("streamBoard", "ak:read", "Board Server-Sent Events stream", "200", "either"),
      },
      "/repositories": {
        get: openApiOperation("listRepositories", "ak:read", "Repositories", "200", "either"),
        post: openApiOperation("createRepository", "ak:write", "Repository created", "201", "either"),
      },
      "/repositories/{repositoryId}": {
        parameters: [openApiPathParameter("repositoryId")],
        get: openApiOperation("getRepository", "ak:read", "Repository", "200", "either"),
        delete: openApiOperation("deleteRepository", "ak:write", "Repository deleted", "200", "either"),
      },
      "/repositories/{repositoryId}/github-token": {
        parameters: [openApiPathParameter("repositoryId")],
        post: openApiOperation("createRepositoryGithubToken", "ak:read", "Short-lived GitHub App token created", "200", "either"),
      },
      "/github-app/config": { get: openApiOperation("getGithubAppConfig", "ak:read", "GitHub App configuration") },
      "/github-app/setup": { get: openApiOperation("completeGithubAppSetup", "ak:read", "GitHub App installation setup") },
      "/github-app/repositories": { get: openApiOperation("listGithubAppRepositories", "ak:read", "GitHub App repositories") },
      "/admin/stats": { get: openApiOperation("getAdminStats", "ak:read", "AK business statistics") },
      "/admin/machines": { get: openApiOperation("listAdminMachines", "ak:read", "AK machine statistics") },
    },
  }),
);

api.get("/api/ping", (c) => c.json({ pong: true }));

// ─── GitHub App webhook receiver (no session auth — HMAC-verified) ───
// Registered BEFORE the `api.use("/api/*", authMiddleware)` block below:
// Hono applies middleware only to routes registered after the use() call, so
// moving this route (or the middleware) changes its auth exposure.
// One platform GitHub App delivers all installations' pull_request events
// here, signed with the app webhook secret (GITHUB_APP_WEBHOOK_SECRET).
// Users only install the app on their repositories — no per-user setup.

api.post("/api/webhooks/github-app", async (c) => {
  const secret = c.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) throw new HTTPException(503, { message: "GitHub App webhook is not configured" });
  const signature = c.req.header("x-hub-signature-256");
  const body = await c.req.text();
  if (!signature || !(await verifyGithubSignature(secret, body, signature))) {
    throw new HTTPException(401, { message: "Invalid webhook signature" });
  }
  const event = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");
  const payload = JSON.parse(body);
  if (event === "pull_request") {
    const taskSync = await handleGithubPullRequestEvent(c.env.DB, c.env, payload);
    const maintainerDispatch = await handleGithubMaintainerEvent(c.env.DB, c.env, {
      event,
      deliveryId,
      payload,
    });
    return c.json({ ok: true, ...taskSync, maintainer_dispatch: maintainerDispatch });
  }
  if (event === "issues" || event === "issue_comment" || event === "pull_request_review" || event === "pull_request_review_comment") {
    return c.json({
      ok: true,
      ...(await handleGithubMaintainerEvent(c.env.DB, c.env, {
        event,
        deliveryId,
        payload,
      })),
    });
  }
  if (event === "installation") {
    return c.json({ ok: true, ...(await handleGithubInstallationEvent(c.env.DB, payload)) });
  }
  if (event === "installation_repositories") {
    return c.json({ ok: true, ...(await handleGithubInstallationRepositoriesEvent(c.env.DB, payload)) });
  }
  return c.json({ ok: true, handled: false });
});

// ─── Public Share Routes (no auth required) ───

api.get("/api/share/:slug", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });

  const publicTasks = board.tasks.map((t) => ({
    id: t.id,
    seq: t.seq,
    title: t.title,
    status: t.status,
    labels: t.labels,
    repository_name: t.repository_name,
    agent_name: t.agent_name,
    agent_public_key: t.agent_public_key,
    scheduled_at: t.scheduled_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));

  return c.json({ ...board, tasks: publicTasks });
});

api.get("/api/share/:slug/badge.svg", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });

  const badge = await getShareBadge(c.env.DB, board.id, board.owner_id, c.req.query("type"));
  const svg = renderMetricBadge("AK", badge.value);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
});

api.get("/api/sitemap.xml", async (c) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://agent-kanban.dev/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`;
  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
});

api.get("/api/share/:slug/stream", async (c) => {
  const board = await getBoardBySlug(c.env.DB, c.req.param("slug"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return createPublicBoardSSEResponse(c.env, board.id);
});

// ─── Share SSR (meta tag injection for social sharing) ───

api.get("/share/*", async (c) => {
  const slug = c.req.path.replace(/^\/share\/?/, "").replace(/\/$/, "");
  const asset = await c.env.ASSETS.fetch(new URL("/", c.req.url));
  let html = await asset.text();

  if (slug) {
    const board = await c.env.DB.prepare("SELECT name, description FROM boards WHERE share_slug = ? AND visibility = 'public'")
      .bind(slug)
      .first<{ name: string; description: string | null }>();

    if (board) {
      const countRow = await c.env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) as todo,
          SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
          SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) as in_review,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done
        FROM tasks t
        JOIN boards b ON t.board_id = b.id
        WHERE b.share_slug = ?
      `)
        .bind(slug)
        .first<{ total: number; todo: number; in_progress: number; in_review: number; done: number }>();

      const counts = countRow || { total: 0, todo: 0, in_progress: 0, in_review: 0, done: 0 };
      const title = `${escapeHtml(board.name)} — Agent Kanban`;
      const description = escapeHtml(
        board.description ||
          `${counts.total} tasks: ${counts.done} done, ${counts.in_progress} active, ${counts.in_review} review, ${counts.todo} todo`,
      );
      const url = `https://agent-kanban.dev/share/${slug}`;

      const metaTags = [
        `<title>${title}</title>`,
        `<meta name="description" content="${description}" />`,
        `<meta property="og:type" content="website" />`,
        `<meta property="og:url" content="${url}" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${description}" />`,
        `<meta property="og:site_name" content="Agent Kanban" />`,
        `<meta name="twitter:card" content="summary" />`,
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${description}" />`,
      ].join("\n    ");

      html = html.replace(/<title>.*?<\/title>/, metaTags);
    }
  }

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

// Auth middleware for all API routes except Realmroot discovery/session endpoints.
api.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  return authMiddleware(c, next);
});

// CLI version gate — reject outdated CLI versions (skip heartbeat so old machines can still report in)
api.use("/api/*", async (c, next) => {
  if (c.req.path.match(/^\/api\/machines\/[^/]+\/heartbeat$/)) return next();
  return cliVersionMiddleware(c, next);
});

// Metrics — write AE data point for machine/agent requests (fire-and-forget)
api.use("/api/*", metricsMiddleware);

// ─── Machines ───

api.post("/api/machines/:id/heartbeat", async (c) => {
  const body = await c.req.json<{ version?: string; runtimes?: MachineRuntime[]; usage_info?: any }>();
  if (body.runtimes !== undefined) assertValidMachineRuntimes(body.runtimes);
  const machineId = c.req.param("id");
  const boundMachineId = c.get("machineId");
  if (boundMachineId && boundMachineId !== machineId) {
    throw new HTTPException(403, { message: "Realmroot machine authority is bound to a different machine" });
  }
  if (!boundMachineId) await assertNativeMachineBinding(c, machineId);

  const updated = await updateMachine(c.env.DB, machineId, c.get("ownerId"), body);
  if (!updated) throw new HTTPException(404, { message: "Machine not found" });

  return c.json(publicMachine(updated));
});

api.get("/api/machines", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) await detectStaleMachines(c.env.DB);
  const machines = await listMachines(c.env.DB, c.get("ownerId"));
  const machinesWithStatus = await machinesWithRuntimeStatus(c.env.DB, c.env, c.get("ownerId"), machines);
  return c.json(machinesWithStatus.map(publicMachine));
});

api.get("/api/machines/:id", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) await detectStaleMachines(c.env.DB);
  const machine = await getMachine(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!machine) throw new HTTPException(404, { message: "Machine not found" });
  const [machineWithStatus] = await machinesWithRuntimeStatus(c.env.DB, c.env, c.get("ownerId"), [machine]);
  return c.json(publicMachine(machineWithStatus));
});

api.post("/api/machines", async (c) => {
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ name: string; os: string; version: string; runtimes: MachineRuntime[]; device_id: string }>();
  if (!body.name || !body.os || !body.version || !body.runtimes || !body.device_id) {
    throw new HTTPException(400, { message: "name, os, version, runtimes, and device_id are required" });
  }
  assertValidMachineRuntimes(body.runtimes);
  const principal = c.get("principal");
  const existingMachine = await c.env.DB.prepare("SELECT id FROM machines WHERE owner_id = ? AND device_id = ?")
    .bind(ownerId, body.device_id)
    .first<{ id: string }>();
  if (principal.type === "machine" && existingMachine?.id !== principal.subjectId) {
    throw new HTTPException(403, { message: "Realmroot machine authority cannot register a different machine" });
  }
  if (existingMachine && principal.type === "human") {
    const bindings = await c.env.DB.prepare(
      `SELECT subject_id FROM realmroot_native_machine_bindings
       WHERE tenant_id = ? AND machine_id = ?`,
    )
      .bind(ownerId, existingMachine.id)
      .all<{ subject_id: string }>();
    if (bindings.results.length > 0 && !bindings.results.some((binding) => binding.subject_id === principal.subjectId)) {
      throw new HTTPException(403, { message: "Native machine is bound to a different Realmroot subject" });
    }
  }
  let machine =
    principal.type === "human"
      ? await upsertNativeMachine(c.env.DB, ownerId, principal.subjectId, body)
      : await upsertMachine(c.env.DB, ownerId, body);
  if (!machine) throw new HTTPException(403, { message: "Native machine is bound to a different Realmroot subject" });
  const amaConnected = isAmaTaskDispatchConfigured(c.env);
  if (amaConnected) {
    const environmentId = await ensureMachineAmaEnvironment(c.env.DB, c.env, ownerId, machine);
    machine = (await updateMachineAmaEnvironment(c.env.DB, machine.id, ownerId, environmentId)) ?? machine;
  }

  const runner = amaConnected ? await createMachineRunnerOnboarding(c.env, machine, ownerId) : null;
  return c.json({ ...publicMachine(machine), runner }, 201);
});

// Cloud sandbox: an AMA-managed execution environment with no device, daemon,
// or runner. AMA scales sandboxes per session. Creates the cloud AMA
// environment first, then persists the machine row referencing it.
api.post("/api/machines/cloud", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Cloud sandboxes require AMA to be configured" });
  }
  await requireAmaConnected(c.env.DB, c.env, c.get("ownerId"));
  const ownerId = c.get("ownerId");
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  const name = body?.name?.trim() || "Cloud sandbox";

  const { environmentId } = await createAmaCloudSandboxEnvironment(c.env.DB, c.env, ownerId, name);
  const machine = await createCloudMachine(c.env.DB, ownerId, { name, runtimes: ["ama"], amaEnvironmentId: environmentId });
  return c.json(publicMachine(machine), 201);
});

api.delete("/api/machines/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const machineId = c.req.param("id");
  // AMA has no hard delete; archive the machine's AMA environment (soft delete)
  // before removing the AK row. Read the env id first since deleteMachine drops it.
  const machine = await c.env.DB.prepare("SELECT ama_environment_id FROM machines WHERE id = ? AND owner_id = ?")
    .bind(machineId, ownerId)
    .first<{ ama_environment_id: string | null }>();
  if (machine?.ama_environment_id && isAmaTaskDispatchConfigured(c.env)) {
    const amaProjectId = await getAmaProjectId(c.env.DB, ownerId);
    if (amaProjectId) await archiveAmaEnvironment(c.env, ownerId, amaProjectId, machine.ama_environment_id);
  }
  const deleted = await deleteMachine(c.env.DB, machineId, ownerId);
  if (!deleted) throw new HTTPException(404, { message: "Machine not found" });

  return c.json({ ok: true });
});

// ─── AMA ───

// Idempotently initializes the tenant's AMA project and session-secret vault.
api.post("/api/ama/provision", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "AMA is not configured" });
  }
  const ownerId = c.get("ownerId");
  await requireAmaConnected(c.env.DB, c.env, ownerId);
  const integration = await ensureAmaOwnerIntegration(c.env.DB, c.env, ownerId);
  // Backfill agents that predate AMA: give each a backing AMA agent so old
  // agents become dispatchable without being recreated. Runs on every
  // Resource initialization and legacy Agent backfill are idempotent.
  // because it only touches rows still missing an ama_agent_id. Per-agent
  // failures are logged and skipped so one bad agent can't block the rest —
  // the next provision retries whatever is still missing.
  const backfill = await backfillAgentAmaIds(c.env.DB, c.env, ownerId, integration.amaProjectId);
  return c.json({ ok: true, project_id: integration.amaProjectId, agents_backfilled: backfill.backfilled, agents_backfill_failed: backfill.failed });
});

async function backfillAgentAmaIds(db: D1, env: Env, ownerId: string, projectId: string): Promise<{ backfilled: number; failed: number }> {
  const pending = await listAgentsMissingAmaAgent(db, ownerId);
  let backfilled = 0;
  let failed = 0;
  for (const agent of pending) {
    try {
      await ensureAmaAgentForAkAgent(db, env, ownerId, agent.id, projectId, amaRuntimeName(agent.runtime));
      await clearAmaBackfillFailedTaint(db, ownerId, agent.id);
      backfilled += 1;
    } catch (err) {
      failed += 1;
      await markAmaBackfillFailed(db, ownerId, agent.id);
      logger.warn(
        `ama agent backfill failed owner=${ownerId} agent=${agent.id} username=${agent.username} runtime=${agent.runtime}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (pending.length > 0) logger.info(`ama agent backfill: ${backfilled}/${pending.length} for owner ${ownerId}; failed=${failed}`);
  return { backfilled, failed };
}

async function markAmaBackfillFailed(db: D1, ownerId: string, agentId: string): Promise<void> {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) return;
  const taints = withAmaBackfillFailedTaint(agent.taints);
  if (JSON.stringify(taints) === JSON.stringify(agent.taints ?? [])) return;
  await updateAgent(db, agentId, { taints });
}

async function clearAmaBackfillFailedTaint(db: D1, ownerId: string, agentId: string): Promise<void> {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) return;
  const taints = withoutAmaBackfillFailedTaint(agent.taints);
  if (JSON.stringify(taints) === JSON.stringify(agent.taints ?? [])) return;
  await updateAgent(db, agentId, { taints });
}

// ─── Models ───

api.get("/api/models", async (c) => {
  const runtime = c.req.query("runtime");
  if (!runtime) throw new HTTPException(400, { message: `runtime is required. Must be one of: ${AGENT_RUNTIMES.join(", ")}` });
  assertValidAgentRuntime(runtime);
  const models = await listRuntimeModels(c.env.DB, c.env, c.get("ownerId"), runtime as AgentRuntime);
  return c.json(models);
});

// ─── Agents ───

api.get("/api/agents", async (c) => {
  const role = c.req.query("role");
  const runtime = c.req.query("runtime") as AnyAgentRuntime | undefined;
  const available = parseOptionalBoolean(c.req.query("available"), "available");
  const maintainerOnly = parseOptionalBoolean(c.req.query("maintainer"), "maintainer");
  const amaRuntime = isAmaTaskDispatchConfigured(c.env);
  assertValidAgentRole(role);
  assertKnownAgentRuntime(runtime);
  const agents = await listAgents(c.env.DB, c.get("ownerId"), {
    kind: parseOptionalAgentKind(c.req.query("kind")),
    role,
    runtime,
    available: amaRuntime ? undefined : available,
  });
  // When AMA is the runtime substrate, local machine heartbeats no longer
  // describe schedulability. Recompute it from live AMA runners.
  const availableRuntimes = amaRuntime ? await availableRuntimeNames(c.env.DB, c.env, c.get("ownerId")) : undefined;
  const withSource = agents.map((agent) => withRuntimeSource(c.env, agent, availableRuntimes));
  const filtered = maintainerOnly === true ? withSource.filter((agent) => isMaintainerAgentProfile(agent)) : withSource;
  return c.json(available === undefined ? filtered : filtered.filter((agent) => agent.status.schedulable === available));
});

api.get("/api/agents/:id", async (c) => {
  const agent = await getAgent(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const logs = await getAgentLogs(c.env.DB, c.req.param("id"));
  const availableRuntimes = isAmaTaskDispatchConfigured(c.env) ? await availableRuntimeNames(c.env.DB, c.env, c.get("ownerId")) : undefined;
  return c.json({ ...withRuntimeSource(c.env, agent, availableRuntimes), logs });
});

api.post("/api/agents", async (c) => {
  const body = await c.req.json<{
    name?: string;
    username: string;
    bio?: string;
    soul?: string;
    role?: string;
    kind?: "worker" | "leader";
    handoff_to?: string[];
    runtime: string;
    model?: string;
    skills?: string[];
    subagents?: string[];
    taints?: AgentTaint[];
  }>();
  assertJsonObject(body, "agent");
  if (!body.username) throw new HTTPException(400, { message: "username is required" });
  assertValidAgentKind(body.kind);
  if (!body.runtime) throw new HTTPException(400, { message: "runtime is required" });
  if (!isValidUsername(body.username)) throw new HTTPException(400, { message: `Invalid username "${body.username}"` });
  assertValidAgentRole(body.role);
  assertValidHandoffRoles(body.handoff_to);
  assertValidAgentRuntime(body.runtime, body.kind ?? "worker");
  if (body.role && RESERVED_ROLES.has(body.role)) {
    throw new HTTPException(403, { message: `Role "${body.role}" is reserved for built-in agents` });
  }
  assertValidSkillRefs(body.skills);
  assertValidAgentTaints(body.taints);
  assertSubagentList(body.subagents);
  assertSubagentRuntime(body.runtime, body.subagents);
  const ownerId = c.get("ownerId");
  const isWorker = (body.kind ?? "worker") === "worker";

  const existingUsername = await c.env.DB.prepare("SELECT owner_id FROM agents WHERE username = ? LIMIT 1")
    .bind(body.username)
    .first<{ owner_id: string }>();
  if (existingUsername && existingUsername.owner_id !== ownerId) {
    throw new HTTPException(409, { message: `Username "${body.username}" is already taken` });
  }
  const latestIdentity = existingUsername
    ? await c.env.DB.prepare(
        "SELECT id, kind, public_key, private_key, fingerprint FROM agents WHERE username = ? AND owner_id = ? AND version = 'latest'",
      )
        .bind(body.username, ownerId)
        .first<{
          id: string;
          kind: "worker" | "leader";
          public_key: string;
          private_key: string;
          fingerprint: string;
        }>()
    : null;
  if (latestIdentity?.kind === "leader") {
    throw new HTTPException(409, { message: "Leader agents cannot be modified" });
  }
  if (latestIdentity && latestIdentity.kind !== (body.kind ?? "worker")) {
    throw new HTTPException(409, { message: "Agent kind cannot be changed" });
  }
  // Worker agents are dispatch targets and need a backing AMA agent. Leaders
  // only authenticate/review inside AK, so they do not mirror to AMA.
  if (isWorker) await requireAmaConnected(c.env.DB, c.env, ownerId);
  await assertRegisteredSubagents(c.env.DB, ownerId, body.subagents);

  if (body.kind === "leader") {
    const existingLeader = await c.env.DB.prepare(
      "SELECT 1 FROM agents WHERE owner_id = ? AND runtime = ? AND kind = 'leader' AND version = 'latest'",
    )
      .bind(ownerId, body.runtime)
      .first();
    if (existingLeader) {
      throw new HTTPException(409, { message: `Leader agent for runtime "${body.runtime}" already exists` });
    }
  }

  const email = agentEmail(body.username);
  const identity = latestIdentity
    ? {
        id: latestIdentity.id,
        publicKeyBase64: latestIdentity.public_key,
        fingerprint: latestIdentity.fingerprint,
        privateKeyJwk: JSON.parse(latestIdentity.private_key) as JsonWebKey,
      }
    : await createAgentIdentity();

  // AMA-first: create the AMA agent before persisting anything. If it throws,
  // the request fails and no AK agent row is written. Standalone AK (AMA not
  // configured) skips this entirely — requireAmaConnected was a no-op above.
  let amaAgentId: string | null = null;
  if (isWorker && isAmaTaskDispatchConfigured(c.env)) {
    const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
    const amaAgent = await createAmaAgentForAkProfile(c.env.DB, c.env, ownerId, body as CreateAgentInput, amaProjectId, amaRuntimeName(body.runtime));
    amaAgentId = amaAgent.id;
  }
  const prepared = await prepareAgent(c.env.DB, ownerId, body as CreateAgentInput, identity, false, amaAgentId);

  // External service — create mailbox (skip if MAILS_ADMIN_TOKEN not configured)
  const mailboxToken = c.env.MAILS_ADMIN_TOKEN && !existingUsername ? await createMailbox(c.env.MAILS_ADMIN_TOKEN, email) : undefined;

  try {
    // Single atomic insert with all fields
    const agent = await upsertLatestAgent(c.env.DB, prepared, {
      mailboxToken,
    });

    return c.json(agent, 201);
  } catch (err) {
    if (!existingUsername) {
      await deleteMailbox(c.env.MAILS_ADMIN_TOKEN, email).catch((cleanupErr: unknown) => {
        logger.warn(`mailbox cleanup failed for ${email}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      });
    }
    throw err;
  }
});

api.patch("/api/agents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const existing = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!existing) throw new HTTPException(404, { message: "Agent not found" });
  if (existing.builtin) throw new HTTPException(403, { message: "Built-in agents cannot be modified" });
  if (existing.kind === "leader") throw new HTTPException(403, { message: "Leader agents cannot be modified" });
  if (existing.version !== "latest") throw new HTTPException(409, { message: "Agent snapshots cannot be modified" });
  const body = await c.req.json();
  assertJsonObject(body, "agent update");
  const updates = body as Partial<CreateAgentInput>;
  assertValidAgentRole(updates.role);
  assertValidHandoffRoles(updates.handoff_to);
  assertValidAgentRuntime(updates.runtime, existing.kind);
  assertValidSkillRefs(updates.skills);
  assertValidAgentTaints(updates.taints);
  assertSubagentList(updates.subagents);
  const runtime = updates.runtime ?? existing.runtime;
  const subagents = updates.subagents ?? existing.subagents;
  assertSubagentRuntime(runtime, subagents);
  await assertRegisteredSubagents(c.env.DB, ownerId, subagents, existing.id);
  if (existing.kind === "worker" && isAmaTaskDispatchConfigured(c.env)) {
    await requireAmaConnected(c.env.DB, c.env, ownerId);
    const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
    const nextProfile = {
      ...existing,
      ...Object.fromEntries(Object.entries(updates).filter(([, value]) => value !== undefined)),
      runtime,
      subagents,
    };
    await syncAmaAgentForAkProfile(
      c.env.DB,
      c.env,
      ownerId,
      existing.id,
      nextProfile,
      existing.ama_agent_id ?? null,
      amaProjectId,
      amaRuntimeName(runtime),
    );
  }
  const agent = await updateAgent(c.env.DB, c.req.param("id"), updates);
  return c.json(agent);
});

api.delete("/api/agents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await c.env.DB.prepare("SELECT id, username, builtin, version, ama_agent_id FROM agents WHERE id = ? AND owner_id = ?")
    .bind(c.req.param("id"), ownerId)
    .first<{ id: string; username: string; builtin: number; version: string; ama_agent_id: string | null }>();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  if (agent.builtin) throw new HTTPException(403, { message: "Built-in agents cannot be deleted" });
  if (agent.version !== "latest") throw new HTTPException(409, { message: "Agent snapshots cannot be deleted directly" });
  // AMA has no hard delete; archive the AMA agent (soft delete, keeps history).
  if (isAmaTaskDispatchConfigured(c.env) && agent.ama_agent_id) {
    const amaProjectId = await getAmaProjectId(c.env.DB, ownerId);
    if (amaProjectId) await archiveAmaAgent(c.env, ownerId, amaProjectId, agent.ama_agent_id);
  }
  const email = agentEmail(agent.username);
  await deleteAgent(c.env.DB, agent.id);
  const remaining = await c.env.DB.prepare("SELECT 1 FROM agents WHERE username = ? LIMIT 1").bind(agent.username).first();
  if (c.env.MAILS_ADMIN_TOKEN && !remaining) {
    await deleteMailbox(c.env.MAILS_ADMIN_TOKEN, email);
  }

  return c.json({ ok: true });
});

// ─── Subagents ───

api.get("/api/subagents", async (c) => {
  const subagents = await listSubagents(c.env.DB, c.get("ownerId"));
  return c.json(subagents);
});

api.get("/api/subagents/:id", async (c) => {
  const subagent = await getSubagent(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  return c.json(subagent);
});

api.post("/api/subagents", async (c) => {
  const body = await c.req.json<CreateSubagentInput>();
  assertJsonObject(body, "subagent");
  if (!body.username) throw new HTTPException(400, { message: "username is required" });
  if (!isValidUsername(body.username)) throw new HTTPException(400, { message: `Invalid username "${body.username}"` });
  assertValidAgentRole(body.role);
  assertModels(body.models);
  assertValidSkillRefs(body.skills);
  const subagent = await createSubagent(c.env.DB, c.get("ownerId"), body);
  return c.json(subagent, 201);
});

api.patch("/api/subagents/:id", async (c) => {
  const body = await c.req.json();
  assertJsonObject(body, "subagent update");
  const updates = body as Partial<CreateSubagentInput>;
  assertValidAgentRole(updates.role);
  assertModels(updates.models);
  assertValidSkillRefs(updates.skills);
  const subagent = await updateSubagent(c.env.DB, c.req.param("id"), c.get("ownerId"), updates);
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  return c.json(subagent);
});

api.delete("/api/subagents/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const subagent = await getSubagent(c.env.DB, c.req.param("id"), ownerId);
  if (!subagent) throw new HTTPException(404, { message: "Subagent not found" });
  await assertSubagentNotReferenced(c.env.DB, ownerId, subagent.id);
  await deleteSubagent(c.env.DB, subagent.id, ownerId);
  return c.json({ ok: true });
});

// ─── Agent Sessions ───

async function assertOwnedAgent(c: { env: Env; get: (key: "ownerId") => string; req: { param: (name: string) => string } }): Promise<void> {
  const agent = await c.env.DB.prepare("SELECT id FROM agents WHERE id = ? AND owner_id = ? AND version = 'latest'")
    .bind(c.req.param("agentId"), c.get("ownerId"))
    .first();
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
}

async function assertOwnedAgentSession(c: Context<{ Bindings: Env }>): Promise<void> {
  const session = await c.env.DB.prepare(
    `SELECT s.id, s.machine_id
     FROM agent_sessions s
     JOIN agents a ON a.id = s.agent_id
     WHERE s.id = ? AND s.agent_id = ? AND a.owner_id = ? AND a.version = 'latest'
     UNION ALL
     SELECT s.id, NULL AS machine_id
     FROM ama_agent_sessions s
     JOIN agents a ON a.id = s.agent_id AND a.owner_id = s.owner_id
     WHERE s.id = ? AND s.agent_id = ? AND s.owner_id = ? AND a.version = 'latest'
     LIMIT 1`,
  )
    .bind(c.req.param("sessionId"), c.req.param("agentId"), c.get("ownerId"), c.req.param("sessionId"), c.req.param("agentId"), c.get("ownerId"))
    .first<{ id: string; machine_id: string | null }>();
  if (!session) throw new HTTPException(404, { message: "Agent session not found" });
  const principal = c.get("principal");
  if (principal.type === "agent" && (c.get("agentId") !== c.req.param("agentId") || c.get("sessionId") !== c.req.param("sessionId"))) {
    throw new HTTPException(403, { message: "Agent authority is bound to a different Session" });
  }
  if (principal.type === "machine" && c.get("machineId") !== session.machine_id) {
    throw new HTTPException(403, { message: "Realmroot machine authority is bound to a different session machine" });
  }
  if (principal.type === "human" && session.machine_id) await assertNativeMachineBinding(c, session.machine_id);
}

async function assertNativeMachineBinding(c: Context<{ Bindings: Env }>, machineId: string): Promise<void> {
  const principal = c.get("principal");
  if (principal.type !== "human") throw new HTTPException(403, { message: "Machine binding required" });
  const binding = await c.env.DB.prepare(
    `SELECT 1 FROM realmroot_native_machine_bindings
     WHERE tenant_id = ? AND subject_id = ? AND machine_id = ?`,
  )
    .bind(c.get("ownerId"), principal.subjectId, machineId)
    .first();
  if (!binding) throw new HTTPException(403, { message: "Native subject is not bound to this machine" });
}

function assertWebSocketOrigin(c: Context<{ Bindings: Env }>): void {
  const expectedOrigin = new URL(resourceUrl(c.env, c.req.url)).origin;
  if (c.req.header("origin") !== expectedOrigin) {
    throw new HTTPException(403, { message: "Invalid WebSocket origin" });
  }
}

api.post("/api/agents/:agentId/sessions", async (c) => {
  markLegacyRuntimeSurface(c);
  await assertOwnedAgent(c);
  const body = await c.req.json<{ session_id: string; session_public_key: string; machine_id: string }>();
  if (!body.session_id || !body.session_public_key || !body.machine_id) {
    throw new HTTPException(400, { message: "session_id, session_public_key, and machine_id are required" });
  }
  const authorityMachineId = c.get("machineId");
  if (authorityMachineId && authorityMachineId !== body.machine_id) {
    throw new HTTPException(403, { message: "Realmroot machine authority is bound to a different machine" });
  }
  if (!authorityMachineId) await assertNativeMachineBinding(c, body.machine_id);
  const machine = await getMachine(c.env.DB, body.machine_id, c.get("ownerId"));
  if (!machine) throw new HTTPException(404, { message: "Machine not found" });

  const result = await createSession(c.env.DB, c.env, c.req.param("agentId"), machine.id, body.session_id, body.session_public_key, c.get("ownerId"));
  return c.json(result, 201);
});

api.delete("/api/agents/:agentId/sessions/:sessionId", async (c) => {
  markLegacyRuntimeSurface(c);
  await assertOwnedAgentSession(c);
  await closeSession(c.env.DB, c.req.param("sessionId"));
  return c.json({ ok: true });
});

api.post("/api/agents/:agentId/sessions/:sessionId/reopen", async (c) => {
  markLegacyRuntimeSurface(c);
  await assertOwnedAgentSession(c);
  await reopenSession(c.env.DB, c.req.param("sessionId"));
  return c.json({ ok: true });
});

api.get("/api/agents/:agentId/sessions", async (c) => {
  markLegacyRuntimeSurface(c);
  await assertOwnedAgent(c);
  const sessions = await listSessions(c.env.DB, c.req.param("agentId"));
  if (!isAmaTaskDispatchConfigured(c.env)) return c.json(sessions);

  const ownerId = c.get("ownerId");
  const projectId = await getAmaProjectId(c.env.DB, ownerId);
  if (!projectId) return c.json(sessions);
  const enriched = await Promise.all(
    sessions.map(async (session) => {
      const amaSessionId = typeof (session as any).ama_session_id === "string" ? (session as any).ama_session_id : null;
      if (!amaSessionId) return session;
      const runtimeSession = await readAmaSession(c.env, ownerId, amaSessionId, projectId).catch(() => null);
      return {
        ...session,
        runtime_session: runtimeSession,
        runtime_status: typeof runtimeSession?.status === "string" ? runtimeSession.status : null,
      };
    }),
  );
  return c.json(enriched);
});

api.patch("/api/agents/:agentId/sessions/:sessionId/usage", async (c) => {
  await assertOwnedAgentSession(c);
  const boundAgentId = c.get("agentId");
  if (boundAgentId && boundAgentId !== c.req.param("agentId")) {
    throw new HTTPException(403, { message: "AK Agent Session is bound to a different Agent" });
  }
  const body = await c.req.json();
  await updateSessionUsage(c.env.DB, c.req.param("sessionId"), body);
  return c.json({ ok: true });
});

// ─── Tasks ───

// Tenant isolation: all /api/tasks/:id routes verify the task belongs to the caller's org
api.use("/api/tasks/:id/*", async (c, next) => {
  await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
  return next();
});
api.use("/api/tasks/:id", async (c, next) => {
  if (c.req.method === "POST") return next(); // POST /api/tasks creates new tasks (no :id param match here anyway)
  await assertTaskOwner(c.env.DB, c.req.param("id"), c.get("ownerId"));
  return next();
});

api.post("/api/tasks", async (c) => {
  const body = await c.req.json();
  normalizeTaskDetailAlias(body);
  if (!body.title) throw new HTTPException(400, { message: "title is required" });

  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const normalized = parseScheduledAt(body.scheduled_at);
    if (!normalized) throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    body.scheduled_at = normalized;
  }

  const { actorType, actorId } = resolveActor(c);
  const runtimeSource = body.assigned_to
    ? await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), body.assigned_to, 400)
    : null;
  const task = await createTask(c.env.DB, c.get("ownerId"), {
    ...body,
    ...(runtimeSource ? { metadata: metadataWithRuntimeSource(body.metadata, runtimeSource) } : {}),
    actorType,
    actorId,
    skipRuntimeAvailability: isAmaTaskDispatchConfigured(c.env),
  });
  let dispatched: Task;
  try {
    dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), task, { apiOrigin: new URL(c.req.url).origin });
  } catch (error) {
    await deleteTaskAfterFailedDispatch(c.env.DB, task.id);
    throw error;
  }
  return c.json(dispatched, 201);
});

api.get("/api/tasks", async (c) => {
  const { repository_id, status, label, board_id, parent, assigned_to } = c.req.query();
  const runtime_source = c.get("machineId") ? "legacy" : undefined;
  const tasks = await listTasks(c.env.DB, c.get("ownerId"), { repository_id, status, label, board_id, parent, assigned_to, runtime_source });
  return c.json(tasks);
});

api.get("/api/tasks/:id", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return c.json(task);
});

async function taskAmaSessionBinding(db: D1, task: Task): Promise<{ sessionId: string; projectId?: string; akSessionId?: string }> {
  const annotations = task.metadata?.annotations;
  const taskAnnotations =
    annotations && typeof annotations === "object" && !Array.isArray(annotations) ? (annotations as Record<string, unknown>) : {};
  const sessionId = taskAnnotations["ama.sessionId"];
  const projectId = typeof taskAnnotations["ama.projectId"] === "string" ? taskAnnotations["ama.projectId"] : undefined;
  if (typeof sessionId !== "string" || !sessionId) {
    const annotatedAkSessionId = taskAnnotations.agentSessionId;
    const activeSessionId = (task as Task & { active_session_id?: unknown }).active_session_id;
    const akSessionId =
      typeof annotatedAkSessionId === "string" && annotatedAkSessionId
        ? annotatedAkSessionId
        : typeof activeSessionId === "string" && activeSessionId
          ? activeSessionId
          : null;
    if (akSessionId) {
      const akSession = await getAmaAgentSession(db, akSessionId);
      if (akSession?.ama_session_id) return { sessionId: akSession.ama_session_id, projectId, akSessionId };
    }
    throw new HTTPException(404, { message: "Task is not bound to a session" });
  }
  return { sessionId, projectId };
}

api.get("/api/tasks/:id/session", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const { sessionId, projectId, akSessionId } = await taskAmaSessionBinding(c.env.DB, task);
  const session = await readAmaSession(c.env, c.get("ownerId"), sessionId, projectId);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  return c.json({ task_id: task.id, session_id: sessionId, project_id: projectId ?? null, ak_session_id: akSessionId ?? null, session });
});

async function ownerAmaProjectId(c: { env: Env; get: (key: "ownerId") => string }): Promise<string> {
  const projectId = await getAmaProjectId(c.env.DB, c.get("ownerId"));
  if (!projectId) throw new HTTPException(404, { message: "AMA project is not configured" });
  return projectId;
}

async function amaSocketProjectId(c: Context<{ Bindings: Env }>): Promise<string> {
  const projectId = c.req.query("projectId");
  if (projectId === undefined) return ownerAmaProjectId(c);
  if (!AMA_PROJECT_ID_PATTERN.test(projectId)) {
    throw new HTTPException(400, { message: "Invalid AMA project ID" });
  }
  return projectId;
}

api.get("/api/sessions", async (c) => {
  const projectId = await ownerAmaProjectId(c);
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50;
  const archivedQuery = c.req.query("archived");
  const page = await listAmaSessions(c.env, c.get("ownerId"), projectId, {
    limit: normalizedLimit,
    cursor: c.req.query("cursor"),
    state: c.req.query("state"),
    labelSelector: c.req.query("labelSelector"),
    ...(archivedQuery !== undefined ? { archived: archivedQuery === "true" } : {}),
  });
  return c.json(page);
});

api.get("/api/sessions/:sessionId", async (c) => {
  const projectId = await ownerAmaProjectId(c);
  const sessionId = c.req.param("sessionId");
  const session = await readAmaSession(c.env, c.get("ownerId"), sessionId, projectId);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  return c.json({ session_id: sessionId, project_id: projectId, session });
});

api.get("/api/sessions/:sessionId/ws", async (c) => {
  const projectId = await ownerAmaProjectId(c);
  const url = await getAmaSessionSocketUrl(c.env, c.get("ownerId"), c.req.param("sessionId"), projectId);
  return c.json({ url });
});

api.get("/api/ama/sessions/:sessionId/socket", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HTTPException(426, { message: "WebSocket upgrade required" });
  const principal = c.get("principal");
  const isWebSession = c.get("identityType") === "user" && principal.source === "session";
  const isNativeHuman = c.get("identityType") === "user" && principal.source === "token" && principal.type === "human";
  const isAkAgent = principal.source === "session" && principal.type === "agent";
  if (!isWebSession && !isNativeHuman && !isAkAgent) {
    throw new HTTPException(403, { message: "AK user or Agent authority is required for the AMA session socket" });
  }
  if (isWebSession) assertWebSocketOrigin(c);
  const amaGrantSubjectId = isWebSession || isNativeHuman ? principal.subjectId : undefined;
  const projectId = await amaSocketProjectId(c);
  const sessionId = c.req.param("sessionId");
  const session = await readAmaSession(c.env, c.get("ownerId"), sessionId, projectId, amaGrantSubjectId);
  if (!session) throw new HTTPException(404, { message: "Session not found" });
  return proxyAmaSessionSocket(c.env, c.get("ownerId"), sessionId, projectId, amaGrantSubjectId);
});

// Chat and CLI receive an AK WebSocket URL; AMA authority never reaches them.
api.get("/api/tasks/:id/session/ws", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const { sessionId, projectId } = await taskAmaSessionBinding(c.env.DB, task);
  const url = await getAmaSessionSocketUrl(c.env, c.get("ownerId"), sessionId, projectId);
  return c.json({ url });
});

api.patch("/api/tasks/:id", async (c) => {
  const body = await c.req.json();
  normalizeTaskDetailAlias(body);

  if (body.input !== undefined && body.input !== null && typeof body.input !== "object") {
    throw new HTTPException(400, { message: "input must be a JSON object or null" });
  }
  if (body.metadata !== undefined && body.metadata !== null && (typeof body.metadata !== "object" || Array.isArray(body.metadata))) {
    throw new HTTPException(400, { message: "metadata must be a JSON object or null" });
  }
  if (body.scheduled_at !== undefined && body.scheduled_at !== null) {
    const normalized = parseScheduledAt(body.scheduled_at);
    if (!normalized) throw new HTTPException(400, { message: "scheduled_at must be ISO 8601 with timezone (e.g. 2026-03-28T09:00:00Z)" });
    body.scheduled_at = normalized;
  }

  const existingTask = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!existingTask) throw new HTTPException(404, { message: "Task not found" });

  // Workers can only update tasks they created
  if (c.get("identityType") === "agent:worker") {
    if (existingTask.created_by !== c.get("agentId")) throw new HTTPException(403, { message: "Workers can only update tasks they created" });
  }

  const task = await updateTask(c.env.DB, c.req.param("id"), body, c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  return c.json(task);
});

api.delete("/api/tasks/:id", async (c) => {
  const existingTask = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!existingTask) throw new HTTPException(404, { message: "Task not found" });

  // Workers can only delete tasks they created
  if (c.get("identityType") === "agent:worker") {
    if (existingTask.created_by !== c.get("agentId")) throw new HTTPException(403, { message: "Workers can only delete tasks they created" });
  }

  const deleted = await deleteTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!deleted) throw new HTTPException(404, { message: "Task not found" });
  return c.json({ ok: true });
});

// ─── Task Lifecycle ───

api.post("/api/tasks/:id/claim", async (c) => {
  const agentId = c.get("agentId");
  if (!agentId) throw new HTTPException(400, { message: "agent_id is required" });
  if (c.get("identityType") === "agent:worker") {
    const routed = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
    if (!routed || taskRuntimeSource(routed) !== c.get("agentRuntimeSource")) {
      throw new HTTPException(409, { message: "Task is routed to a different runtime source" });
    }
  }

  const task = await claimTask(c.env.DB, c.req.param("id"), agentId, taskIdentity(c), c.get("sessionId") || null, c.get("agentRuntimeSource"));
  return c.json(task);
});

api.post("/api/tasks/:id/complete", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) return c.json(task);
  const identity = await validateTaskManagementTransition(c, "complete", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const completed = await completeTask(c.env.DB, task.id, actorType, actorId, identity, sessionId);
  return c.json(completed);
});

api.post("/api/tasks/:id/release", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) return c.json(task);
  const identity = await validateTaskManagementTransition(c, "release", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const released = await releaseTask(c.env.DB, task.id, actorType, actorId, identity, "released", sessionId);
  if (!released) return c.json(released);
  const dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), released, {
    apiOrigin: new URL(c.req.url).origin,
  });
  return c.json(dispatched);
});

api.post("/api/tasks/:id/assign", async (c) => {
  const body = await c.req.json<{ agent_id: string }>();
  const targetAgentId = body.agent_id;
  if (!targetAgentId) throw new HTTPException(400, { message: "agent_id is required" });

  const { actorType, actorId, sessionId } = resolveActor(c);
  const existing = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!existing) throw new HTTPException(404, { message: "Task not found" });
  await requireTaskManager(c, existing);
  if (existing.status === "todo" && existing.assigned_to === targetAgentId) {
    const existingSource = taskRuntimeSource(existing);
    const source = existingSource ?? (await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), targetAgentId, 404));
    const routed = existingSource
      ? existing
      : ((await updateTask(c.env.DB, existing.id, { metadata: metadataWithRuntimeSource(existing.metadata, source) }, c.get("ownerId"))) ?? existing);
    const dispatched = await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), routed, {
      apiOrigin: new URL(c.req.url).origin,
      takeover: true,
      recordFailure: false,
    });
    return c.json(dispatched);
  }

  if (existing.status !== "todo") throw new HTTPException(409, { message: "Can only assign tasks in todo status" });
  if (existing.assigned_to) throw new HTTPException(409, { message: "Task is already assigned" });
  const targetAgent = await getAgent(c.env.DB, targetAgentId, c.get("ownerId"));
  if (!targetAgent) throw new HTTPException(404, { message: "Agent not found" });
  if (targetAgent.kind !== "worker") throw new HTTPException(400, { message: "Tasks can only be assigned to worker agents" });
  if (hasNoScheduleTaint(targetAgent.taints)) {
    throw new HTTPException(409, { message: "Agent is tainted NoSchedule and cannot be assigned normal tasks" });
  }
  const source = await resolveAssignableWorkerRuntimeSource(c.env.DB, c.env, c.get("ownerId"), targetAgentId, 404);
  const routed = {
    ...existing,
    assigned_to: targetAgentId,
    metadata: metadataWithRuntimeSource(existing.metadata, source),
  };

  const assignmentToken = newLongId();
  const task = await assignTask(c.env.DB, c.req.param("id"), targetAgentId, actorType, actorId, sessionId, {
    skipRuntimeAvailability: isAmaTaskDispatchConfigured(c.env),
    metadata: routed.metadata,
    assignmentToken,
  });
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  try {
    await dispatchAssignedTask(c.env.DB, c.env, c.get("ownerId"), task, {
      apiOrigin: new URL(c.req.url).origin,
      takeover: true,
      recordFailure: false,
    });
  } catch (error) {
    await rollbackTaskAssignment(c.env.DB, task.id, targetAgentId, assignmentToken, existing.metadata, existing.updated_at);
    throw error;
  }
  const finalized = await finalizeTaskAssignment(c.env.DB, task.id, assignmentToken);
  if (!finalized) throw new HTTPException(404, { message: "Task not found" });
  return c.json(finalized);
});

api.post("/api/tasks/:id/cancel", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const identity = await validateTaskManagementTransition(c, "cancel", task);

  await releaseAssignedTaskRuntime(c.env.DB, c.env, c.get("ownerId"), task);
  const cancelled = await cancelTask(c.env.DB, task.id, actorType, actorId, identity, sessionId);
  if (!cancelled) throw new HTTPException(404, { message: "Task not found" });
  return c.json(cancelled);
});

api.post("/api/tasks/:id/review", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { pr_url?: string };
  const { actorType, actorId, sessionId } = resolveActor(c);

  const existing = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!existing) throw new HTTPException(404, { message: "Task not found" });
  const task = await reviewTask(c.env.DB, existing.id, c.get("ownerId"), actorType, actorId, body.pr_url || null, taskIdentity(c), sessionId);
  return c.json(task);
});

api.post("/api/tasks/:id/reject", async (c) => {
  const { actorType, actorId, sessionId } = resolveActor(c);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const identity = await validateTaskManagementTransition(c, "reject", task);

  try {
    await sendTaskRejectToAma(c.env.DB, c.env, c.get("ownerId"), task, body.reason);
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 409) {
      throw new HTTPException(status, { message: "AMA reject delivery was not accepted" });
    }
    throw error;
  }

  const rejected = await rejectTask(c.env.DB, task.id, actorType, actorId, identity, body.reason, sessionId);
  if (!rejected) throw new HTTPException(404, { message: "Task not found" });
  return c.json(rejected);
});

// ─── Task Notes ───

api.post("/api/tasks/:id/notes", async (c) => {
  const body = await c.req.json<{ detail: string }>();
  if (!body.detail) throw new HTTPException(400, { message: "detail is required" });

  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const { actorType, actorId, sessionId } = resolveActor(c);
  if (actorType === "agent:leader" && task.status === "in_progress") {
    await sendTaskMessageToAma(c.env, c.get("ownerId"), task, body.detail);
  }
  const action = await addTaskAction(c.env.DB, c.req.param("id"), actorType, actorId, "commented", body.detail, sessionId);
  return c.json(action, 201);
});

api.get("/api/tasks/:id/notes", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const since = c.req.query("since");
  const actions = await getTaskActions(c.env.DB, c.req.param("id"), since || undefined);
  return c.json(actions);
});

// ─── Messages ───

api.post("/api/tasks/:id/messages", async (c) => {
  const body = await c.req.json<{ sender_type: string; sender_id?: string; content: string }>();
  if (!body.sender_type || !body.content) {
    throw new HTTPException(400, { message: "sender_type and content are required" });
  }
  if (body.sender_type !== "user" && body.sender_type !== "agent") {
    throw new HTTPException(400, { message: "sender_type must be 'user' or 'agent'" });
  }

  const senderId = body.sender_id || (body.sender_type === "agent" ? c.get("agentId") : c.get("ownerId"));
  if (!senderId) throw new HTTPException(400, { message: "sender_id is required" });

  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  if (body.sender_type === "user") {
    await sendTaskMessageToAma(c.env, c.get("ownerId"), task, body.content);
  }
  const message = await createMessage(c.env.DB, c.req.param("id"), body.sender_type, senderId, body.content);
  return c.json(message, 201);
});

api.get("/api/tasks/:id/messages", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });

  const since = c.req.query("since");
  const messages = await listMessages(c.env.DB, c.req.param("id"), since || undefined);
  return c.json(messages);
});

// ─── WebSocket Relay ───

api.get("/api/tunnel/ws", async (c) => {
  markLegacyRuntimeSurface(c);
  const role = c.req.query("role");
  if (role === "daemon") {
    if (c.get("identityType") !== "machine" || !c.get("machineId")) {
      throw new HTTPException(403, { message: "A bound Native machine context is required for the daemon tunnel" });
    }
  } else if (role === "browser") {
    if (c.get("identityType") !== "user" || c.get("principal").source !== "session") {
      throw new HTTPException(403, { message: "An AK Web Session is required for the browser tunnel" });
    }
    assertWebSocketOrigin(c);
    const sessionId = c.req.query("sessionId");
    if (!sessionId) throw new HTTPException(400, { message: "sessionId is required" });
    const session = await c.env.DB.prepare(
      `SELECT s.id FROM agent_sessions s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.id = ? AND a.owner_id = ?
       UNION ALL
       SELECT s.id FROM ama_agent_sessions s
       WHERE s.id = ? AND s.owner_id = ?
       LIMIT 1`,
    )
      .bind(sessionId, c.get("ownerId"), sessionId, c.get("ownerId"))
      .first();
    if (!session) throw new HTTPException(404, { message: "Agent session not found" });
  } else {
    throw new HTTPException(400, { message: "Invalid tunnel role" });
  }
  const ownerId = c.get("ownerId");
  const id = c.env.TUNNEL_RELAY.idFromName(ownerId);
  const stub = c.env.TUNNEL_RELAY.get(id);
  const url = new URL(c.req.url);
  url.pathname = "/ws";
  url.searchParams.set("ownerId", ownerId);
  const upstream = await stub.fetch(new Request(url.toString(), c.req.raw));
  const response = new Response(upstream.body, upstream);
  response.headers.set("Deprecation", "true");
  response.headers.set("Sunset", "2026-09-01T00:00:00Z");
  response.headers.set("X-AK-Runtime-Surface", "legacy-daemon");
  return response;
});

// ─── SSE Stream ───

api.get("/api/tasks/:id/stream", async (c) => {
  const task = await getTask(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  const lastEventId = c.req.header("Last-Event-ID") || null;
  return createSSEResponse(c.env, task.id, lastEventId);
});

api.get("/api/boards/:id/stream", async (c) => {
  return createBoardSSEResponse(c.env, c.req.param("id"), c.get("ownerId"));
});

// ─── Boards ───

api.post("/api/boards", async (c) => {
  const body = await c.req.json<{ name: string; description?: string; type: string }>();
  if (!body.name) throw new HTTPException(400, { message: "name is required" });
  if (!isBoardType(body.type)) throw new HTTPException(400, { message: "type must be 'dev' or 'ops'" });
  const board = await createBoard(c.env.DB, c.get("ownerId"), body.name, body.type, body.description);
  return c.json(board, 201);
});

api.get("/api/boards", async (c) => {
  const ownerId = c.get("ownerId");
  const name = c.req.query("name");
  if (name) {
    const board = await getBoardByName(c.env.DB, ownerId, name);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
    return c.json(board);
  }
  const boards = await listBoards(c.env.DB, ownerId);
  return c.json(boards);
});

api.post("/api/boards/:id/maintainers", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  await requireAmaConnected(c.env.DB, c.env, c.get("ownerId"));

  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const body = await c.req.json<{
    agent_id?: string;
    interval_seconds?: number;
    heartbeat_enabled?: boolean;
    status?: "active" | "paused";
  }>();
  const maintainerAgentId = body.agent_id;
  if (!maintainerAgentId) throw new HTTPException(400, { message: "agent_id is required" });
  const intervalSeconds = body.interval_seconds ?? MAINTAINER_HEARTBEAT_DEFAULT_INTERVAL_SECONDS;
  validateMaintainerHeartbeatInterval(intervalSeconds);
  validateMaintainerHeartbeatEnabled(body.heartbeat_enabled);
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") {
    throw new HTTPException(400, { message: "status must be active or paused" });
  }
  const maintainerStatus = body.status ?? "active";
  const heartbeatEnabled = body.heartbeat_enabled ?? true;

  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const existingMaintainers = await listBoardMaintainers(c.env.DB, ownerId, boardId);
  if (existingMaintainers.length > 0) {
    throw new HTTPException(409, { message: "Board already has a maintainer" });
  }
  const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const maintainerAgent = await ensureMaintainerAgentProfile(c.env.DB, ownerId, maintainerAgentId);
  // The trigger is left unpinned: AMA resolves a runner-capable environment for
  // the runtime at each dispatch, so a daily maintainer lands on whatever
  // machine is healthy then rather than one picked at creation.
  const amaRuntime = amaRuntimeName(maintainerAgent.runtime);
  const amaAgent = await ensureAmaAgentForAkAgent(c.env.DB, c.env, ownerId, maintainerAgentId, amaProjectId, amaRuntime, {
    memoryEnabled: true,
  });
  const maintainerId = newLongId();
  const resourceName = boardMaintainerResourceName(board.id);
  const maintainerSessionMetadata = maintainerAmaSessionMetadata(maintainerId);
  const boardVault = await createBoardMaintainerVault(c.env, ownerId, amaProjectId, board);
  const runtimeEnv = maintainerRuntimeEnv({
    agentId: maintainerAgentId,
    boardId,
    maintainerId,
    apiUrl: apiUrl(c.env, new URL(c.req.url).origin),
  });
  const runtimeSecretEnv = await amaRuntimeSecretEnvForCredentialNames(c.env, ownerId, amaProjectId, boardVault.id, [USER_VARIABLES_CREDENTIAL_NAME]);
  const memoryStore = await createAmaMemoryStore(c.env, ownerId, {
    projectId: amaProjectId,
    name: resourceName,
    description: `Persistent memory for AK board ${boardId} maintainer.`,
  });
  const resourceRefs = [{ type: "memory_store", storeId: memoryStore.id, readOnly: false }];
  const schedule = await createAmaScheduledAgentTrigger(c.env, ownerId, {
    projectId: amaProjectId,
    agentId: amaAgent.id,
    runtime: amaRuntime,
    name: boardMaintainerScheduleTriggerName(board.id),
    promptTemplate: boardMaintainerScheduledPrompt(boardId),
    intervalSeconds,
    status: maintainerScheduledStatus(maintainerStatus, heartbeatEnabled),
    resourceRefs,
    runtimeEnv,
    runtimeSecretEnv,
    metadata: maintainerSessionMetadata,
  });
  const httpTrigger = await createAmaHttpAgentTrigger(c.env, ownerId, {
    projectId: amaProjectId,
    agentId: amaAgent.id,
    runtime: amaRuntime,
    name: boardMaintainerHttpTriggerName(board.id),
    promptTemplate: boardMaintainerHttpPrompt(boardId),
    status: maintainerStatus,
    resourceRefs,
    runtimeEnv,
    runtimeSecretEnv,
    metadata: maintainerSessionMetadata,
    concurrency: "serial",
  });

  const maintainer = await createBoardMaintainer(c.env.DB, ownerId, {
    id: maintainerId,
    boardId,
    agentId: maintainerAgentId,
    amaScheduleId: schedule.id,
    amaHttpTriggerId: httpTrigger.id,
    amaHttpTriggerSerialized: true,
    amaMemoryStoreId: memoryStore.id,
    prompt: "",
    intervalSeconds,
    heartbeatEnabled,
    status: maintainerStatus,
    amaBoardVaultId: boardVault.id,
  });
  return c.json(await publicBoardMaintainerWithAmaStatus(c.env.DB, c.env, ownerId, maintainer), 201);
});

api.get("/api/boards/:id/maintainers", async (c) => {
  const board = await getOwnedBoard(c.env.DB, c.get("ownerId"), c.req.param("id"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainers = await listBoardMaintainers(c.env.DB, c.get("ownerId"), c.req.param("id"));
  return c.json(await listPublicMaintainersWithAmaStatus(c.env.DB, c.env, c.get("ownerId"), maintainers));
});

api.get("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  return c.json(await publicBoardMaintainerWithAmaStatus(c.env.DB, c.env, ownerId, maintainer));
});

api.get("/api/boards/:id/maintainers/:maintainerId/variables", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  if (!maintainer.ama_board_vault_id) return c.json(emptyMaintainerVariables());
  const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const credentials = await listAmaVaultCredentials(c.env, ownerId, amaProjectId, maintainer.ama_board_vault_id);
  return c.json(publicMaintainerVariables(credentials, maintainer.ama_board_vault_id));
});

api.put("/api/boards/:id/maintainers/:maintainerId/variables", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const variables = parseMaintainerVariables(await readJsonBody(c.req.json()));
  const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const boardVaultId = await ensureBoardMaintainerVault(c.env.DB, c.env, ownerId, amaProjectId, board, maintainer);
  const credentials = await listAmaVaultCredentials(c.env, ownerId, amaProjectId, boardVaultId);
  const userVariablesCredential = activeMaintainerCredential(credentials, boardVaultId, USER_VARIABLES_CREDENTIAL_NAME);
  let createdUserVariablesCredential = false;

  if (userVariablesCredential) {
    await updateAmaVaultCredentialSecret(c.env, ownerId, {
      projectId: amaProjectId,
      vaultId: boardVaultId,
      credentialId: userVariablesCredential.id,
      referenceName: USER_VARIABLES_CREDENTIAL_NAME,
      secretData: variables,
      metadata: { boardId, maintainerId: maintainer.id },
    });
  } else {
    await createAmaSessionSecret(c.env, ownerId, {
      projectId: amaProjectId,
      vaultId: boardVaultId,
      name: USER_VARIABLES_CREDENTIAL_NAME,
      secretData: variables,
      metadata: { boardId, maintainerId: maintainer.id },
    });
    createdUserVariablesCredential = true;
  }

  if (createdUserVariablesCredential) {
    await syncMaintainerSecretEnvRefs(c.env, ownerId, amaProjectId, boardVaultId, maintainer);
  }
  const refreshed = await listAmaVaultCredentials(c.env, ownerId, amaProjectId, boardVaultId);
  return c.json(publicMaintainerVariables(refreshed, boardVaultId));
});

api.post("/api/boards/:id/maintainers/:maintainerId/sessions", async (c) => {
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainerId = c.req.param("maintainerId");

  const body = await c.req.json<{
    session_id?: string;
    session_public_key?: string;
    ama_session_id?: string | null;
    ama_trigger_run_id?: string | null;
  }>();
  if (!body.session_id || typeof body.session_id !== "string") {
    throw new HTTPException(400, { message: "session_id is required" });
  }
  if (!body.session_public_key || typeof body.session_public_key !== "string") {
    throw new HTTPException(400, { message: "session_public_key is required" });
  }

  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, maintainerId);
  if (!maintainer || maintainer.status === "archived") throw new HTTPException(404, { message: "Board maintainer not found" });
  if (maintainer.status !== "active") throw new HTTPException(409, { message: "Board maintainer is not active" });
  if (c.get("identityType") === "agent:leader" && c.get("agentId") !== maintainer.agent_id) {
    throw new HTTPException(403, { message: "AK Agent Session is bound to a different maintainer" });
  }

  const result = await createAmaAgentSession(c.env.DB, c.env, {
    ownerId,
    agentId: maintainer.agent_id,
    sessionId: body.session_id,
    sessionPublicKey: body.session_public_key,
    amaSessionId: body.ama_session_id ?? null,
  });
  return c.json({ agent_id: maintainer.agent_id, session_id: body.session_id, ...result }, 201);
});

api.patch("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const board = await getOwnedBoard(c.env.DB, ownerId, boardId);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const body = await c.req.json<{ interval_seconds?: number; heartbeat_enabled?: boolean; status?: "active" | "paused" }>();
  if (body.interval_seconds !== undefined) validateMaintainerHeartbeatInterval(body.interval_seconds);
  validateMaintainerHeartbeatEnabled(body.heartbeat_enabled);
  if (body.status !== undefined && body.status !== "active" && body.status !== "paused") {
    throw new HTTPException(400, { message: "status must be active or paused" });
  }
  const nextStatus = body.status ?? (maintainer.status === "archived" ? "paused" : maintainer.status);
  const nextHeartbeatEnabled = body.heartbeat_enabled ?? maintainer.heartbeat_enabled;
  const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const maintainerAgent = await ensureMaintainerAgentProfile(c.env.DB, ownerId, maintainer.agent_id);
  const amaRuntime = amaRuntimeName(maintainerAgent.runtime);
  const amaAgent = await ensureAmaAgentForAkAgent(c.env.DB, c.env, ownerId, maintainer.agent_id, amaProjectId, amaRuntime, {
    memoryEnabled: true,
  });
  const boardVaultId = await ensureBoardMaintainerVault(c.env.DB, c.env, ownerId, amaProjectId, board, maintainer);
  const runtimeEnv = maintainerRuntimeEnv({
    agentId: maintainer.agent_id,
    boardId,
    maintainerId: maintainer.id,
    apiUrl: apiUrl(c.env, new URL(c.req.url).origin),
  });
  const runtimeSecretEnv = await amaRuntimeSecretEnvForCredentialNames(c.env, ownerId, amaProjectId, boardVaultId, [USER_VARIABLES_CREDENTIAL_NAME]);
  const resourceRefs = maintainer.ama_memory_store_id ? [{ type: "memory_store", storeId: maintainer.ama_memory_store_id, readOnly: false }] : [];
  const maintainerSessionMetadata = maintainerAmaSessionMetadata(maintainer.id);
  const schedule = await updateAmaScheduledAgentTrigger(c.env, ownerId, amaProjectId, maintainer.ama_schedule_id, {
    agentId: amaAgent.id,
    runtime: amaRuntime,
    promptTemplate: boardMaintainerScheduledPrompt(boardId),
    intervalSeconds: body.interval_seconds,
    status:
      body.status !== undefined || body.heartbeat_enabled !== undefined ? maintainerScheduledStatus(nextStatus, nextHeartbeatEnabled) : undefined,
    resourceRefs,
    runtimeEnv,
    runtimeSecretEnv,
    metadata: maintainerSessionMetadata,
  });
  if (maintainer.ama_http_trigger_id) {
    await updateAmaHttpAgentTrigger(c.env, ownerId, amaProjectId, maintainer.ama_http_trigger_id, {
      agentId: amaAgent.id,
      runtime: amaRuntime,
      promptTemplate: boardMaintainerHttpPrompt(boardId),
      status: body.status,
      resourceRefs,
      runtimeEnv,
      runtimeSecretEnv,
      metadata: maintainerSessionMetadata,
      concurrency: "serial",
    });
    await markBoardMaintainerHttpTriggerSerialized(c.env.DB, ownerId, boardId, maintainer.id);
  }
  const updated = await updateBoardMaintainer(c.env.DB, ownerId, boardId, maintainer.id, {
    intervalSeconds: body.interval_seconds ?? schedule.schedule.intervalSeconds,
    heartbeatEnabled: body.heartbeat_enabled,
    status: body.status,
  });
  if (!updated) throw new HTTPException(404, { message: "Board maintainer not found" });
  return c.json(await publicBoardMaintainerWithAmaStatus(c.env.DB, c.env, ownerId, updated));
});

api.get("/api/boards/:id/maintainers/:maintainerId/runs", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const projectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  const triggerIds = [maintainer.ama_schedule_id, maintainer.ama_http_trigger_id].filter((id): id is string => Boolean(id));
  const pages = await Promise.all(
    triggerIds.map((triggerId) => listAmaTriggerRuns(c.env, ownerId, projectId, triggerId, { limit: normalizedLimit })),
  );
  const allRuns = pages.flatMap((page) => page.data);
  const runs = allRuns.sort((a, b) => (maintainerRunTimestamp(b) ?? "").localeCompare(maintainerRunTimestamp(a) ?? "")).slice(0, normalizedLimit);
  return c.json({
    data: runs.map(publicMaintainerRun),
    pagination: { limit: normalizedLimit, hasMore: allRuns.length > normalizedLimit || pages.some((page) => page.pagination?.hasMore === true) },
  });
});

api.get("/api/boards/:id/maintainers/:maintainerId/memories", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 100;
  const cursor = c.req.query("cursor");
  if (!maintainer.ama_memory_store_id) {
    return c.json({ data: [], pagination: { limit: normalizedLimit, hasMore: false } });
  }
  const projectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  const page = await listAmaMemoryStoreMemories(c.env, ownerId, projectId, maintainer.ama_memory_store_id, {
    limit: normalizedLimit,
    cursor,
  });
  return c.json({
    data: page.data.map(publicMaintainerMemory),
    pagination: { limit: normalizedLimit, hasMore: page.pagination?.hasMore === true },
  });
});

api.delete("/api/boards/:id/maintainers/:maintainerId", async (c) => {
  if (!isAmaTaskDispatchConfigured(c.env)) {
    throw new HTTPException(500, { message: "Task dispatch runtime is not configured" });
  }
  const ownerId = c.get("ownerId");
  const boardId = c.req.param("id");
  const maintainer = await getBoardMaintainer(c.env.DB, ownerId, boardId, c.req.param("maintainerId"));
  if (!maintainer) throw new HTTPException(404, { message: "Board maintainer not found" });
  const amaProjectId = await resolveAmaProjectId(c.env.DB, c.env, ownerId);
  // Hard delete: the AMA trigger (and its runs) and the AK maintainer row are
  // both removed. Pause/resume covers "stop but keep"; delete is permanent.
  await deleteAmaScheduledAgentTrigger(c.env, ownerId, amaProjectId, maintainer.ama_schedule_id);
  if (maintainer.ama_http_trigger_id) await deleteAmaTrigger(c.env, ownerId, amaProjectId, maintainer.ama_http_trigger_id);
  if (maintainer.ama_memory_store_id) await archiveAmaMemoryStore(c.env, ownerId, amaProjectId, maintainer.ama_memory_store_id);
  await deleteBoardMaintainer(c.env.DB, ownerId, boardId, maintainer.id);
  return c.json({ ok: true });
});

api.get("/api/boards/:id", async (c) => {
  const board = await getBoard(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.patch("/api/boards/:id", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string; visibility?: "private" | "public"; labels?: any[] }>();
  const board = await updateBoard(c.env.DB, c.req.param("id"), c.get("ownerId"), body);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.post("/api/boards/:id/labels", async (c) => {
  const body = await c.req.json<{ name: string; color: string; description?: string }>();
  const board = await createBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), {
    name: body.name,
    color: body.color,
    description: body.description || "",
  });
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board, 201);
});

api.patch("/api/boards/:id/labels/:name", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string; description?: string }>();
  const board = await updateBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), c.req.param("name"), body);
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.delete("/api/boards/:id/labels/:name", async (c) => {
  const board = await deleteBoardLabel(c.env.DB, c.req.param("id"), c.get("ownerId"), c.req.param("name"));
  if (!board) throw new HTTPException(404, { message: "Board not found" });
  return c.json(board);
});

api.delete("/api/boards/:id", async (c) => {
  const deleted = await deleteBoard(c.env.DB, c.req.param("id"), c.get("ownerId"));
  if (!deleted) throw new HTTPException(404, { message: "Board not found" });
  return c.json({ ok: true });
});

const AK_MAINTAINER_SKILL_REF = "saltbo/agent-kanban@ak-maintainer";
const AK_MAINTAINER_TAINT: AgentTaint = { key: MAINTAINER_TAINT_KEY, value: "board-maintainer", effect: "NoSchedule" };
const AMA_BACKFILL_FAILED_TAINT: AgentTaint = { key: AMA_BACKFILL_FAILED_TAINT_KEY, value: "ama-agent-create-failed", effect: "NoSchedule" };

function sameTaint(a: AgentTaint, b: AgentTaint): boolean {
  return a.key === b.key && a.effect === b.effect && (a.value ?? null) === (b.value ?? null);
}

function withMaintainerTaint(taints: AgentTaint[] | null | undefined): AgentTaint[] {
  const current = taints ?? [];
  return current.some((taint) => sameTaint(taint, AK_MAINTAINER_TAINT)) ? current : [...current, AK_MAINTAINER_TAINT];
}

function withAmaBackfillFailedTaint(taints: AgentTaint[] | null | undefined): AgentTaint[] {
  const current = taints ?? [];
  return current.some((taint) => sameTaint(taint, AMA_BACKFILL_FAILED_TAINT)) ? current : [...current, AMA_BACKFILL_FAILED_TAINT];
}

function withoutAmaBackfillFailedTaint(taints: AgentTaint[] | null | undefined): AgentTaint[] {
  return (taints ?? []).filter((taint) => !sameTaint(taint, AMA_BACKFILL_FAILED_TAINT));
}

function withMaintainerSkill(skills: string[] | null | undefined): string[] {
  return [...new Set([...(skills ?? []), AK_MAINTAINER_SKILL_REF])];
}

function isMaintainerAgentProfile(agent: { kind: string; role?: string | null; skills?: string[] | null; taints?: AgentTaint[] | null }) {
  return (
    agent.kind === "worker" &&
    (agent.role === "board-maintainer" ||
      (agent.skills ?? []).includes(AK_MAINTAINER_SKILL_REF) ||
      (agent.taints ?? []).some((taint) => sameTaint(taint, AK_MAINTAINER_TAINT)))
  );
}

async function ensureMaintainerAgentProfile(db: D1, ownerId: string, agentId: string) {
  const agent = await getAgent(db, agentId, ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  if (agent.kind !== "worker") throw new HTTPException(400, { message: "Board maintainers must use worker agents" });
  if (!isMaintainerAgentProfile(agent)) {
    throw new HTTPException(400, { message: "Board maintainers must use a maintainer agent" });
  }
  const skills = withMaintainerSkill(agent.skills);
  const taints = withMaintainerTaint(agent.taints);
  if (JSON.stringify(skills) === JSON.stringify(agent.skills ?? []) && JSON.stringify(taints) === JSON.stringify(agent.taints ?? [])) {
    return agent;
  }
  const updated = await updateAgent(db, agent.id, { skills, taints });
  if (!updated) throw new HTTPException(404, { message: "Agent not found" });
  return updated;
}
function boardMaintainerBasePrompt(boardId: string) {
  return [
    `You are the maintainer for AK board ${boardId}.`,
    `Discover the current repository scope with AK. Every repository currently attached to board ${boardId} is in your maintenance scope.`,
    `Follow the installed ${AK_MAINTAINER_SKILL_REF} skill. The skill is the source of truth for maintainer workflow, GitHub identity, heartbeat behavior, memory policy, task creation, and response rules.`,
    "Read or create HEARTBEAT.md before acting when memory is available, and update it before finishing scheduled heartbeat runs.",
  ];
}

function boardMaintainerScheduledPrompt(boardId: string) {
  return [...boardMaintainerBasePrompt(boardId), "", "Run type: scheduled heartbeat."].join("\n");
}

function boardMaintainerHttpPrompt(boardId: string) {
  return [
    "{% if .ama.run.session_reused == false %}",
    `# AK Maintainer GitHub Event`,
    "",
    `You are the maintainer for AK board ${boardId}.`,
    `Discover the current repository scope with AK. Every repository currently attached to board ${boardId} is in your maintenance scope.`,
    `Follow the installed ${AK_MAINTAINER_SKILL_REF} skill. The skill is the source of truth for maintainer workflow, GitHub identity, heartbeat behavior, memory policy, task creation, and response rules.`,
    "Read or create HEARTBEAT.md before acting when memory is available, and update it before finishing scheduled heartbeat runs.",
    "{% else %}",
    "# GitHub Event",
    "{% endif %}",
    "",
    "## Event",
    "",
    "- Event: `{{ .body.event }}.{{ .body.action }}`",
    "- Delivery: `{{ .body.delivery_id }}`",
    "- Routing key: `{{ .body.routing_key }}`",
    "- Repository: `{{ .body.repository.full_name }}`",
    "- Repository URL: {{ .body.repository.html_url }}",
    "- Sender: `{{ .body.sender.login }}`",
    '{% if .body.subject.type == "issue" %}',
    "- Issue: #{{ .body.subject.number }}",
    "- Issue URL: {{ .body.subject.html_url }}",
    "{% endif %}",
    '{% if .body.subject.type == "pull_request" %}',
    "- Pull request: #{{ .body.subject.number }}",
    "- Pull request URL: {{ .body.subject.html_url }}",
    "{% endif %}",
    "{% if .body.comment.id %}",
    "",
    "## Comment",
    "",
    "- Comment ID: `{{ .body.comment.id }}`",
    "- Comment node ID: `{{ .body.comment.node_id }}`",
    "- Comment author: `{{ .body.comment.user.login }}`",
    "- Comment URL: {{ .body.comment.html_url }}",
    "{% endif %}",
    "{% if .body.review.id %}",
    "",
    "## Review",
    "",
    "- Review ID: `{{ .body.review.id }}`",
    "- Review node ID: `{{ .body.review.node_id }}`",
    "- Review author: `{{ .body.review.user.login }}`",
    "- Review state: `{{ .body.review.state }}`",
    "- Review URL: {{ .body.review.html_url }}",
    "{% endif %}",
    "",
    "## Required Action",
    "",
    "Use the maintainer skill's GitHub event workflow to fetch issue, PR, comment, or review content before responding.",
  ].join("\n");
}

const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MAINTAINER_VARIABLES = 100;
type MaintainerVaultCredential = Awaited<ReturnType<typeof listAmaVaultCredentials>>[number];

async function readJsonBody(input: Promise<unknown>): Promise<unknown> {
  try {
    return await input;
  } catch {
    throw new HTTPException(400, { message: "Request body must be valid JSON" });
  }
}

function parseMaintainerVariables(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HTTPException(400, { message: "variables must be an object" });
  }
  const variables = (body as Record<string, unknown>).variables;
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw new HTTPException(400, { message: "variables must be an object" });
  }
  const entries = Object.entries(variables);
  if (entries.length > MAX_MAINTAINER_VARIABLES) {
    throw new HTTPException(400, { message: `variables cannot contain more than ${MAX_MAINTAINER_VARIABLES} keys` });
  }
  if (entries.length === 0) {
    throw new HTTPException(400, { message: "variables must contain at least one key" });
  }
  const normalized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
      throw new HTTPException(400, { message: `Invalid environment variable name: ${name}` });
    }
    if (typeof value !== "string") {
      throw new HTTPException(400, { message: `Environment variable ${name} must be a string` });
    }
    if (value.length === 0) {
      throw new HTTPException(400, { message: `Environment variable ${name} cannot be empty` });
    }
    if (value.length > 16000) {
      throw new HTTPException(400, { message: `Environment variable ${name} is too large` });
    }
    normalized[name] = value;
  }
  return Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)));
}

function emptyMaintainerVariables() {
  return { data: [], credential_id: null, updated_at: null };
}

function activeMaintainerCredential(
  credentials: MaintainerVaultCredential[],
  vaultId: string,
  credentialName: string,
): MaintainerVaultCredential | null {
  const matches = credentials.filter((credential) => credential.state === "active" && credential.name === credentialName);
  if (matches.length > 1) {
    throw new HTTPException(409, { message: `AMA vault ${vaultId} has multiple active credentials named ${credentialName}` });
  }
  return matches[0] ?? null;
}

function publicMaintainerVariables(credentials: MaintainerVaultCredential[], vaultId: string) {
  const credential = activeMaintainerCredential(credentials, vaultId, USER_VARIABLES_CREDENTIAL_NAME);
  if (!credential) return emptyMaintainerVariables();
  return {
    data: credential.dataKeys
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name })),
    credential_id: credential.id,
    updated_at: credential.updatedAt,
  };
}

async function syncMaintainerSecretEnvRefs(env: Env, ownerId: string, amaProjectId: string, boardVaultId: string, maintainer: BoardMaintainer) {
  const runtimeSecretEnv = await amaRuntimeSecretEnvForCredentialNames(env, ownerId, amaProjectId, boardVaultId, [USER_VARIABLES_CREDENTIAL_NAME]);
  await updateAmaScheduledAgentTrigger(env, ownerId, amaProjectId, maintainer.ama_schedule_id, { runtimeSecretEnv });
  if (maintainer.ama_http_trigger_id) {
    await updateAmaHttpAgentTrigger(env, ownerId, amaProjectId, maintainer.ama_http_trigger_id, { runtimeSecretEnv });
  }
}

async function createBoardMaintainerVault(env: Env, ownerId: string, amaProjectId: string, board: { id: string; name: string }) {
  return await createAmaVault(env, ownerId, {
    projectId: amaProjectId,
    name: boardMaintainerResourceName(board.id),
    description: `Runtime variables for AK board ${board.id}.`,
    scope: "project",
  });
}

async function ensureBoardMaintainerVault(
  db: D1,
  env: Env,
  ownerId: string,
  amaProjectId: string,
  board: { id: string; name: string },
  maintainer: BoardMaintainer,
): Promise<string> {
  if (maintainer.ama_board_vault_id) return maintainer.ama_board_vault_id;
  const vault = await createBoardMaintainerVault(env, ownerId, amaProjectId, board);
  await setBoardMaintainerVaultId(db, ownerId, board.id, maintainer.id, vault.id);
  return vault.id;
}

function maintainerRuntimeEnv(input: { agentId: string; boardId: string; maintainerId: string; apiUrl: string }): Record<string, string> {
  return {
    AK_WORKER: "1",
    AK_AGENT_ID: input.agentId,
    AK_BOARD_ID: input.boardId,
    AK_MAINTAINER_ID: input.maintainerId,
    AK_API_URL: input.apiUrl,
  };
}

function maintainerAmaSessionMetadata(maintainerId: string) {
  return {
    labels: { maintainerId },
    annotations: {
      [AMA_ANNOTATION_KEY_IDLE_TIMEOUT_SECONDS]: String(MAINTAINER_SESSION_IDLE_TIMEOUT_SECONDS),
    },
  };
}

// ─── Admin ───

function requireAdmin(c: { get: (key: string) => any }) {
  if ((c.get("user") as any)?.role !== "admin") {
    throw new HTTPException(403, { message: "FORBIDDEN" });
  }
}

api.get("/api/admin/stats", async (c) => {
  requireAdmin(c);
  const stats = await getSystemStats(c.env.DB);
  if (isAmaTaskDispatchConfigured(c.env)) {
    const machines = await listAllMachines(c.env.DB);
    const machinesWithStatus = await machinesWithRuntimeStatusByOwner(c.env.DB, c.env, machines);
    stats.machines.online = machinesWithStatus.filter((machine) => machine.status === "online").length;
  }
  return c.json(stats);
});

api.get("/api/admin/machines", async (c) => {
  requireAdmin(c);
  if (!isAmaTaskDispatchConfigured(c.env)) await detectStaleMachines(c.env.DB);
  const machines = await listAllMachines(c.env.DB);
  const machinesWithStatus = await machinesWithRuntimeStatusByOwner(c.env.DB, c.env, machines);
  const metrics = await getMachineMetrics(c.env);
  return c.json(machinesWithStatus.map((m) => ({ ...m, metrics: metrics.get(m.id) ?? null })));
});

// ─── Repositories ───

// App config + this owner's install status, so the UI can show the slug-based
// install link and reflect whether the owner has already connected the App.
api.get("/api/github-app/config", async (c) => {
  const slug = c.env.GITHUB_APP_SLUG ?? null;
  const active = (await getInstallationsForOwner(c.env.DB, c.get("ownerId"))).filter((i) => i.suspendedAt === null);
  return c.json({
    configured: isGithubAppConfigured(c.env),
    slug,
    install_url: slug ? `https://github.com/apps/${slug}/installations/new` : null,
    installed: active.length > 0,
    accounts: active.map((i) => i.accountLogin),
  });
});

// GitHub App "Setup URL" callback. After the user installs/configures the App,
// GitHub redirects here with installation_id; the logged-in user is the
// authoritative owner of that installation.
api.get("/api/github-app/setup", async (c) => {
  if (!isGithubAppConfigured(c.env)) throw new HTTPException(503, { message: "GitHub App is not configured" });
  const installationId = Number(c.req.query("installation_id"));
  if (!Number.isInteger(installationId) || installationId <= 0) {
    throw new HTTPException(400, { message: "installation_id is required" });
  }
  await recordInstallationFromSetup(c.env.DB, c.env, c.get("ownerId"), installationId);
  return c.redirect("/repositories?app_installed=1");
});

// Browse the repos the owner's installation(s) can access, for import. Live
// list from GitHub (authoritative); the per-repo badge on the list uses the
// stored tables instead and never calls GitHub.
api.get("/api/github-app/repositories", async (c) => {
  const ownerId = c.get("ownerId");
  const installs = (await getInstallationsForOwner(c.env.DB, ownerId)).filter((i) => i.suspendedAt === null);
  if (installs.length === 0) return c.json({ installed: false, repositories: [] });

  const existingUrls = new Set((await listRepositories(c.env.DB, ownerId)).map((r) => r.url));
  const lists = await Promise.all(installs.map((install) => listInstallationRepositories(c.env, install.installationId)));
  const seen = new Set<string>();
  const repositories: InstallableRepo[] = [];
  for (const repo of lists.flat()) {
    const key = repo.full_name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push({
      full_name: repo.full_name,
      name: repo.name,
      clone_url: repo.clone_url,
      private: repo.private,
      already_added: existingUrls.has(normalizeGitUrl(repo.clone_url)),
    });
  }
  repositories.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return c.json({ installed: true, repositories });
});

api.post("/api/repositories", async (c) => {
  const body = await c.req.json<{ name: string; url: string }>();
  if (!body.name || !body.url) {
    throw new HTTPException(400, { message: "name and url are required" });
  }
  const ownerId = c.get("ownerId");
  // Soft on App coverage: any URL can be registered; the response carries the
  // App status so the UI can prompt installation. The PAT fallback still pushes.
  const repository = await createRepository(c.env.DB, ownerId, body);
  const app_status = await repoAppStatus(c.env.DB, ownerId, repository.full_name);
  return c.json({ ...repository, app_status }, 201);
});

api.get("/api/repositories", async (c) => {
  const ownerId = c.get("ownerId");
  const { url, board_id } = c.req.query();
  if (board_id) {
    const board = await getOwnedBoard(c.env.DB, ownerId, board_id);
    if (!board) throw new HTTPException(404, { message: "Board not found" });
  }
  const repositories = board_id ? await listBoardRepositories(c.env.DB, ownerId, board_id) : await listRepositories(c.env.DB, ownerId, { url });
  const statuses = await repoAppStatusBatch(
    c.env.DB,
    ownerId,
    repositories.map((r) => r.full_name),
  );
  return c.json(repositories.map((r) => ({ ...r, app_status: statuses.get(r.full_name) })));
});

api.get("/api/repositories/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const repo = await getRepository(c.env.DB, c.req.param("id"), ownerId);
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  const app_status = await repoAppStatus(c.env.DB, ownerId, repo.full_name);
  return c.json({ ...repo, app_status });
});

api.post("/api/repositories/:id/github-token", async (c) => {
  if (!isGithubAppConfigured(c.env)) throw new HTTPException(503, { message: "GitHub App is not configured" });
  const ownerId = c.get("ownerId");
  const repo = await getRepository(c.env.DB, c.req.param("id"), ownerId);
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  if (c.get("identityType") === "agent:worker") {
    const agentId = c.get("agentId");
    const sessionId = c.get("sessionId") || null;
    const allowed = agentId
      ? (await isActiveMaintainerForRepository(c.env.DB, ownerId, agentId, repo.id)) ||
        (await isCurrentTaskWorkerForRepository(c.env.DB, ownerId, agentId, sessionId, repo.id))
      : false;
    if (!allowed) {
      throw new HTTPException(403, { message: "Worker agent is not an active maintainer or current task worker for this repository" });
    }
  }
  const githubUrl = new URL(repo.url);
  const githubParts = githubUrl.pathname.replace(/^\/|\/$/g, "").split("/");
  if (githubUrl.hostname !== "github.com" || githubParts.length !== 2) {
    throw new HTTPException(400, { message: "GitHub auth is only available for github.com repositories" });
  }
  const [githubOwner, githubRepo] = githubParts;
  if ((await repoAppStatus(c.env.DB, ownerId, `${githubOwner}/${githubRepo}`)) !== "covered") {
    throw new HTTPException(403, { message: "GitHub App is not installed for this owner and repository" });
  }
  const github = await mintGithubInstallationToken(c.env, githubOwner, githubRepo);
  return c.json({ repository_id: repo.id, full_name: repo.full_name, token: github.token, expires_at: github.expiresAt });
});

// Unlink only: removes the AK repo row. Never uninstalls the App or removes the
// repo from the GitHub installation — that is the user's choice on GitHub, and
// the installation may cover repos used elsewhere.
api.delete("/api/repositories/:id", async (c) => {
  const ownerId = c.get("ownerId");
  const repo = await getRepository(c.env.DB, c.req.param("id"), ownerId);
  if (!repo) throw new HTTPException(404, { message: "Repository not found" });
  await deleteRepository(c.env.DB, repo.id, ownerId);
  return c.json({ ok: true });
});

// ─── Agent Inbox ───

api.get("/api/agents/:id/inbox", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const mailboxToken = await getAgentMailboxToken(c.env.DB, agent.id);
  if (!mailboxToken) return c.json({ emails: [] });
  const emails = await getInbox(mailboxToken, agentEmail(agent.username));
  return c.json({ emails });
});

api.get("/api/agents/:id/inbox/:emailId", async (c) => {
  const ownerId = c.get("ownerId");
  const agent = await getAgent(c.env.DB, c.req.param("id"), ownerId);
  if (!agent) throw new HTTPException(404, { message: "Agent not found" });
  const mailboxToken = await getAgentMailboxToken(c.env.DB, agent.id);
  if (!mailboxToken) throw new HTTPException(404, { message: "Mailbox not configured" });
  const email = await getEmail(mailboxToken, c.req.param("emailId"));
  return c.json(email);
});

export { api };

// ─── Helpers ───

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type ShareBadgeType = "agents" | "tasks" | "tokens";

const SHARE_BADGE_TYPES = new Set<ShareBadgeType>(["agents", "tasks", "tokens"]);

async function getShareBadge(db: D1, boardId: string, ownerId: string, type: string | undefined): Promise<{ value: string }> {
  const badgeType = SHARE_BADGE_TYPES.has(type as ShareBadgeType) ? (type as ShareBadgeType) : "agents";
  if (badgeType === "agents") return { value: `${await countOwnerAgents(db, ownerId)} agents` };
  if (badgeType === "tasks") return { value: `${await countDoneTasks(db, boardId)} tasks` };
  return { value: `${formatMetric(await sumOwnerTokens(db, ownerId))} tokens` };
}

async function countOwnerAgents(db: D1, ownerId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) as count FROM agents WHERE owner_id = ? AND COALESCE(version, 'latest') = 'latest'")
    .bind(ownerId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countDoneTasks(db: D1, boardId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as count FROM tasks WHERE board_id = ? AND status = 'done'").bind(boardId).first<{ count: number }>();
  return row?.count ?? 0;
}

async function sumOwnerTokens(db: D1, ownerId: string): Promise<number> {
  const row = await db
    .prepare(`
      SELECT COALESCE(SUM(s.input_tokens + s.output_tokens + s.cache_read_tokens + s.cache_creation_tokens), 0) as tokens
      FROM agent_sessions s
      JOIN agents a ON a.id = s.agent_id
      WHERE a.owner_id = ?
    `)
    .bind(ownerId)
    .first<{ tokens: number }>();
  return row?.tokens ?? 0;
}

function formatMetric(value: number): string {
  if (value >= 1_000_000_000) return `${trimMetric(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimMetric(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimMetric(value / 1_000)}K`;
  return String(value);
}

function trimMetric(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function renderMetricBadge(label: string, value: string): string {
  const safeLabel = escapeXml(label);
  const safeValue = escapeXml(value);
  const labelWidth = Math.max(safeLabel.length * 7 + 16, 32);
  const valueWidth = Math.max(safeValue.length * 6.5 + 16, 64);
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#18181b"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#0891b2"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeLabel}</text>
    <text x="${labelWidth / 2}" y="14">${safeLabel}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${safeValue}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${safeValue}</text>
  </g>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function agentEmail(username: string): string {
  return `${username}@mails.agent-kanban.dev`;
}
