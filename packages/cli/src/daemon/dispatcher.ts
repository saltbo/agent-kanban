/**
 * Dispatcher — full task dispatch pipeline + agent environment/GPG helpers.
 *
 * Fetches todo tasks, filters by availability and rate-limit state,
 * resolves runtime, prepares repo, and spawns the agent. Also provides
 * buildAgentEnv / setupGnupgHome / cleanupGnupgHome used by resumer.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRuntime, type BoardType, isBoardType, parseWorktreeConfig, type WorktreeConfig } from "@agent-kanban/shared";
import { type AgentInfo, cleanupPromptFile, generateSystemPrompt, writePromptFile } from "../agent/systemPrompt.js";
import { AgentClient, type ApiClient } from "../client/index.js";
import { getCredentials } from "../config.js";
import { createLogger } from "../logger.js";
import { getAvailableProviders, getProvider, normalizeRuntime } from "../providers/registry.js";
import { getSessionManager } from "../session/manager.js";
import type { SessionFile } from "../session/types.js";
import { ensureSubagents, type SubagentDefinition } from "../workspace/agents.js";
import { ensureCloned, isLocalRepoUrl, prepareDirectRepo, prepareRepo, repoDir } from "../workspace/repoOps.js";
import { materializeSkillSnapshots, prepareSkillSnapshots } from "../workspace/skills.js";
import {
  acquireDirectRepoDir,
  createDirectRepoWorkspace,
  createRepoWorkspace,
  createTempWorkspace,
  isDirectRepoDirInUse,
} from "../workspace/workspace.js";
import { apiCallIdempotent, apiCallOptional, cryptoBoundary, execBoundary, fsSync } from "./boundaries.js";
import type { PrMonitor } from "./prMonitor.js";
import type { RateLimiter } from "./rateLimiter.js";
import type { RuntimeCircuitBreaker } from "./runtimeCircuitBreaker.js";
import { isRuntimeLimitIgnored } from "./runtimeOverrides.js";
import type { RuntimePool } from "./runtimePool.js";

const logger = createLogger("dispatcher");
const preparingTaskIds = new Set<string>();
let dispatchTickInProgress = false;

async function getSubagentDetails(client: ApiClient, subagentIds: string[]): Promise<SubagentDefinition[] | null> {
  if (subagentIds.length === 0) return [];
  const available = (await apiCallOptional("listSubagents", () => client.listSubagents())) as SubagentDefinition[] | null;
  if (!available) return null;
  const byId = new Map(available.map((subagent) => [subagent.id, subagent]));
  const subagents: SubagentDefinition[] = [];
  for (const id of subagentIds) {
    const subagent = byId.get(id);
    if (!subagent) return null;
    subagents.push(subagent);
  }
  return subagents;
}

// ---- Agent environment / GPG helpers ----

export interface BuildEnvOpts {
  agentId: string;
  sessionId: string;
  privateKeyJwk: JsonWebKey;
  agentName: string;
  agentUsername: string;
  gpgSubkeyId: string | null;
  gnupgHome: string | null;
}

export function buildAgentEnv(opts: BuildEnvOpts): Record<string, string> {
  const { agentId, sessionId, privateKeyJwk, agentName, agentUsername, gpgSubkeyId, gnupgHome } = opts;
  const email = `${agentUsername}@mails.agent-kanban.dev`;
  const env: Record<string, string> = {
    AK_WORKER: "1",
    AK_AGENT_ID: agentId,
    AK_SESSION_ID: sessionId,
    AK_AGENT_KEY: JSON.stringify(privateKeyJwk),
    AK_API_URL: getCredentials().apiUrl,
    GIT_AUTHOR_NAME: agentName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: agentName,
    GIT_COMMITTER_EMAIL: email,
  };
  if (gnupgHome && gpgSubkeyId) {
    env.GNUPGHOME = gnupgHome;
    env.GIT_CONFIG_COUNT = "3";
    env.GIT_CONFIG_KEY_0 = "gpg.format";
    env.GIT_CONFIG_VALUE_0 = "openpgp";
    env.GIT_CONFIG_KEY_1 = "user.signingkey";
    env.GIT_CONFIG_VALUE_1 = `${gpgSubkeyId}!`;
    env.GIT_CONFIG_KEY_2 = "commit.gpgsign";
    env.GIT_CONFIG_VALUE_2 = "true";
  }
  return env;
}

export function setupGnupgHome(armoredPrivateKey: string): string {
  const gnupgHome = fsSync("mkdtemp-gpg", () => mkdtempSync(join(tmpdir(), "ak-gpg-")));
  const keyFile = join(gnupgHome, "key.asc");
  fsSync("write-gpg-key", () => writeFileSync(keyFile, armoredPrivateKey, { mode: 0o600 }));
  execBoundary("gpg-import", () =>
    execFileSync("gpg", ["--batch", "--import", keyFile], {
      env: { ...process.env, GNUPGHOME: gnupgHome },
      stdio: "pipe",
    }),
  );
  fsSync("rm-gpg-keyfile", () => rmSync(keyFile));
  return gnupgHome;
}

export function cleanupGnupgHome(gnupgHome: string | null): void {
  if (!gnupgHome) return;
  try {
    execBoundary("gpg-kill-agent", () =>
      execFileSync("gpgconf", ["--kill", "gpg-agent"], {
        env: { ...process.env, GNUPGHOME: gnupgHome },
        stdio: "pipe",
      }),
    );
  } finally {
    fsSync("rm-gnupghome", () => rmSync(gnupgHome, { recursive: true, force: true }));
  }
}

// ---- Dispatch pipeline ----

export interface DispatchOpts {
  maxConcurrent: number;
  pollInterval: number;
}

/**
 * Fetch todo tasks, filter, resolve runtime, prepare repo, dispatch one.
 * Returns true if a task was dispatched.
 */
export async function dispatchTasks(
  client: ApiClient,
  pool: RuntimePool,
  rateLimiter: RateLimiter,
  prMonitor: PrMonitor,
  opts: DispatchOpts,
  circuitBreaker?: RuntimeCircuitBreaker,
): Promise<boolean> {
  // Daemon callbacks can request an immediate tick while the prior tick is
  // still awaiting provider/API preflight. Serialize the full selection
  // window so two ticks cannot reserve the same todo task.
  if (dispatchTickInProgress) return false;
  dispatchTickInProgress = true;
  try {
    return await dispatchTasksExclusive(client, pool, rateLimiter, prMonitor, opts, circuitBreaker);
  } finally {
    dispatchTickInProgress = false;
  }
}

async function dispatchTasksExclusive(
  client: ApiClient,
  pool: RuntimePool,
  rateLimiter: RateLimiter,
  prMonitor: PrMonitor,
  opts: DispatchOpts,
  circuitBreaker?: RuntimeCircuitBreaker,
): Promise<boolean> {
  const tasks = (await client.listTasks({ status: "todo" })) as any[];
  const repos = await client.listRepositories();
  const repoById = new Map(repos.map((r: any) => [r.id, r]));

  for (const t of tasks) {
    if (t.blocked || !t.assigned_to || pool.hasTask(t.id) || preparingTaskIds.has(t.id) || !t.repository_id) continue;
    const repo = repoById.get(t.repository_id);
    if (repo) ensureCloned(repo);
  }

  const now = new Date().toISOString();
  const available = tasks.filter((t: any) => {
    if (t.blocked || !t.assigned_to || pool.hasTask(t.id) || preparingTaskIds.has(t.id)) return false;
    if (t.scheduled_at && t.scheduled_at > now) return false;
    if (!t.repository_id) {
      if (t.board_type === "dev") {
        logger.warn(`Dev task ${t.id} has no repository_id, skipping`);
        return false;
      }
      return true;
    }
    const repo = repoById.get(t.repository_id);
    if (!repo) return false;
    // Worktree-disabled tasks work directly in the shared checkout — one at a time.
    if (!parseWorktreeConfig(t.metadata).enabled && isDirectRepoDirInUse(repoDir(repo.url))) return false;
    return true;
  });

  if (available.length === 0) return false;

  const localRuntimes = new Set(getAvailableProviders().map((provider) => provider.name));
  const agentCache = new Map<string, { runtime: AgentRuntime | null; available: boolean }>();
  let task: any = null;
  let taskRuntime: AgentRuntime | null = null;
  for (const t of available) {
    let agentState = agentCache.get(t.assigned_to);
    if (agentState === undefined) {
      const agent = (await apiCallOptional("getAgent", () => client.getAgent(t.assigned_to))) as any;
      if (!agent) {
        logger.warn(`Agent ${t.assigned_to} not found, skipping task ${t.id}`);
        agentCache.set(t.assigned_to, { runtime: null, available: false });
        continue;
      }
      if (!agent.runtime) {
        logger.warn(`Agent ${t.assigned_to} has no runtime, skipping task ${t.id}`);
        agentCache.set(t.assigned_to, { runtime: null, available: false });
        continue;
      }
      const runtime = normalizeRuntime(agent.runtime);
      const schedulable = typeof agent.status === "object" && agent.status ? agent.status.schedulable : false;
      agentState = { runtime, available: schedulable === true };
      agentCache.set(t.assigned_to, agentState);
    }
    if (!agentState.runtime || !agentState.available || !localRuntimes.has(agentState.runtime)) continue;
    if (pool.activeCountForRuntime(agentState.runtime) >= opts.maxConcurrent) continue;
    const ignoreRuntimeLimit = isRuntimeLimitIgnored(agentState.runtime);
    const localAvailability = ignoreRuntimeLimit ? null : await getProvider(agentState.runtime).checkAvailability?.();
    if (localAvailability && localAvailability.status !== "ready") continue;
    if (
      (ignoreRuntimeLimit || !rateLimiter.isRuntimePaused(agentState.runtime)) &&
      (!circuitBreaker || circuitBreaker.canDispatch(agentState.runtime))
    ) {
      task = t;
      taskRuntime = agentState.runtime;
      break;
    }
  }

  if (!task) return false;

  preparingTaskIds.add(task.id);
  try {
    const worktree = parseWorktreeConfig(task.metadata);
    let dir: string | null = null;
    let repositoryUrl: string | null = null;
    if (task.repository_id) {
      const repo = repoById.get(task.repository_id)!;
      dir = repoDir(repo.url);
      repositoryUrl = repo.url;
      const repoIsLocal = isLocalRepoUrl(repo.url);

      if (worktree.enabled) {
        if (!prepareRepo(dir, { local: repoIsLocal })) {
          logger.error(`Repo not ready at ${dir}, skipping task ${task.id}`);
          return false;
        }
      } else if (!repoIsLocal && !prepareDirectRepo(dir)) {
        logger.error(`Repo not ready at ${dir}, skipping task ${task.id}`);
        return false;
      }
    }

    const boardType = task.board_type;
    if (!isBoardType(boardType)) {
      logger.error(`Task ${task.id} has invalid board_type "${boardType}", skipping`);
      return false;
    }

    if (circuitBreaker && taskRuntime && !circuitBreaker.tryAcquireDispatch(taskRuntime)) return false;
    let dispatched = false;
    try {
      dispatched = await dispatchOne(task, dir, repositoryUrl, boardType, client, pool, worktree);
    } finally {
      if (!dispatched && circuitBreaker && taskRuntime) circuitBreaker.releaseDispatch(taskRuntime);
    }
    if (dispatched) prMonitor.track(task.id);
    return dispatched;
  } finally {
    preparingTaskIds.delete(task.id);
  }
}

/**
 * Single task dispatch: session create -> keys -> workspace -> skills -> env -> spawn.
 */
async function dispatchOne(
  task: any,
  repoDir: string | null,
  repositoryUrl: string | null,
  boardType: BoardType,
  client: ApiClient,
  pool: RuntimePool,
  worktree: WorktreeConfig,
): Promise<boolean> {
  const agentId = task.assigned_to;
  const sessionId = randomUUID();
  // Network-backed preparation is deliberately completed before session and
  // worktree creation. A cache miss may be slow or offline, but it cannot
  // leave an ak/* branch behind.
  const agentDetails = (await apiCallOptional("getAgent", () => client.getAgent(agentId))) as AgentInfo | null;
  if (!agentDetails) {
    logger.error(`Agent ${agentId} not found, skipping task ${task.id}`);
    return false;
  }
  const providerName = normalizeRuntime(agentDetails.runtime);
  const provider = getProvider(providerName);
  const skillSnapshots = prepareSkillSnapshots(agentDetails.skills ?? []);
  if (!skillSnapshots) {
    logger.error(`Skill preflight failed for task ${task.id}; no worktree was created`);
    return false;
  }
  const subagents = await getSubagentDetails(client, agentDetails.subagents ?? []);
  if (!subagents) {
    logger.error(`Subagent preflight failed for task ${task.id}; no worktree was created`);
    return false;
  }

  const gpgSubkeyId = (agentDetails as any).gpg_subkey_id ?? null;
  let armoredGpgKey: string | null = null;
  let gnupgHome: string | null = null;
  if (gpgSubkeyId) {
    const gpgData = (await apiCallOptional("getAgentGpgKey", () => client.getAgentGpgKey(agentId))) as { armored_private_key: string } | null;
    armoredGpgKey = gpgData?.armored_private_key ?? null;
  }

  const { publicKey, privateKey } = (await cryptoBoundary("generateKey", () =>
    crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"]),
  )) as CryptoKeyPair;
  const pubKeyJwk = await cryptoBoundary("exportPubKey", () => crypto.subtle.exportKey("jwk", publicKey));
  const privKeyJwk = (await cryptoBoundary("exportPrivKey", () => crypto.subtle.exportKey("jwk", privateKey))) as JsonWebKey;

  const created = await apiCallIdempotent("createSession", () => client.createSession(agentId, sessionId, (pubKeyJwk as JsonWebKey).x!));
  if (!created) {
    cleanupGnupgHome(gnupgHome);
    return false;
  }

  logger.info(`Session ${sessionId.slice(0, 8)} for agent ${agentId} on task ${task.id}: ${task.title}`);
  const sessions = getSessionManager();
  let workspace: { cwd: string; info: import("../workspace/workspace.js").WorkspaceInfo; cleanup(): void } | null = null;
  let localSessionCreated = false;
  let promptCreated = false;
  const abort = async () => {
    let remoteCompensationComplete = true;
    try {
      await apiCallOptional("closeSession", () => client.closeSession(agentId, sessionId));
    } catch (err) {
      remoteCompensationComplete = false;
      logger.warn(`Failed to close aborted session ${sessionId.slice(0, 8)}: ${(err as Error).message}`);
    }

    let taskStatus: string | null = null;
    try {
      const currentTask = (await apiCallOptional("getTask", () => client.getTask(task.id))) as { status?: string } | null;
      taskStatus = currentTask?.status ?? null;
    } catch (err) {
      remoteCompensationComplete = false;
      logger.warn(`Failed to inspect aborted task ${task.id}: ${(err as Error).message}`);
    }
    // Pre-claim failures normally leave the task assigned in todo so the next
    // tick can retry. Release is only legal after the worker claimed it.
    if (taskStatus === "in_progress") {
      try {
        await apiCallOptional("releaseTask", () => client.releaseTask(task.id));
      } catch (err) {
        remoteCompensationComplete = false;
        logger.warn(`Failed to release aborted task ${task.id}: ${(err as Error).message}`);
      }
    }

    let workspaceCleaned = true;
    if (workspace && remoteCompensationComplete) {
      try {
        workspace.cleanup();
        workspace = null;
      } catch (err) {
        workspaceCleaned = false;
        logger.warn(`Workspace cleanup failed for task ${task.id}: ${(err as Error).message}`);
      }
    } else if (workspace) {
      workspaceCleaned = false;
    }
    if (localSessionCreated && workspaceCleaned) {
      await sessions.forceRemove(sessionId);
      localSessionCreated = false;
    } else if (localSessionCreated) {
      await sessions.patch(sessionId, { cleanupPending: true });
    }
    if (promptCreated) cleanupPromptFile(sessionId);
    cleanupGnupgHome(gnupgHome);
    gnupgHome = null;
  };

  try {
    if (armoredGpgKey) gnupgHome = setupGnupgHome(armoredGpgKey);
    workspace = repoDir
      ? worktree.enabled
        ? fsSync("createRepoWorkspace", () => createRepoWorkspace(repoDir, sessionId, worktree.name))
        : fsSync("createDirectRepoWorkspace", () => createDirectRepoWorkspace(repoDir))
      : fsSync("createTempWorkspace", () => createTempWorkspace(sessionId));

    // Serialize direct-mode tasks for the whole session lifecycle.
    if (workspace.info.type === "direct") acquireDirectRepoDir(workspace.info.repoDir);

    const sessionFile: SessionFile = {
      type: "worker",
      agentId,
      sessionId,
      runtime: providerName,
      startedAt: Date.now(),
      apiUrl: getCredentials().apiUrl,
      privateKeyJwk: privKeyJwk,
      taskId: task.id,
      workspace: workspace.info,
      status: "active",
      model: agentDetails.model ?? undefined,
      reasoningEffort: agentDetails.reasoning_effort ?? undefined,
      gpgSubkeyId,
      agentUsername: (agentDetails as any).username ?? agentId,
      agentName: agentDetails.name,
    };
    await sessions.create(sessionFile);
    localSessionCreated = true;

    if (!materializeSkillSnapshots(workspace.cwd, skillSnapshots)) throw new Error("skill snapshot materialization failed");
    if (!(await ensureSubagents(workspace.cwd, providerName, subagents))) throw new Error("subagent materialization failed");

    const apiUrl = getCredentials().apiUrl;
    const agentClient = new AgentClient(apiUrl, agentId, sessionId, privateKey);
    const agentEnv = buildAgentEnv({
      agentId,
      sessionId,
      privateKeyJwk: privKeyJwk,
      agentName: agentDetails.name,
      agentUsername: (agentDetails as any).username ?? agentId,
      gpgSubkeyId,
      gnupgHome,
    });
    const systemPromptFile = writePromptFile(sessionId, generateSystemPrompt(agentDetails, boardType, subagents));
    promptCreated = true;
    const taskContext = [
      `Task ID: ${task.id}`,
      `Title: ${task.title}`,
      task.description ? `Description: ${task.description}` : null,
      task.labels?.length ? `Labels: ${task.labels.join(", ")}` : null,
      task.repository_id ? `Repository: ${repositoryUrl ?? task.repository_id}` : null,
      `Board: ${task.board_id}`,
    ]
      .filter(Boolean)
      .join("\n");

    const ownedWorkspace = workspace;
    await pool.spawnAgent({
      provider,
      taskId: task.id,
      sessionId,
      cwd: ownedWorkspace.cwd,
      taskContext,
      agentClient,
      agentEnv,
      systemPromptFile,
      onCleanup: () => {
        try {
          ownedWorkspace.cleanup();
        } finally {
          cleanupGnupgHome(gnupgHome);
        }
      },
      model: agentDetails.model ?? undefined,
      reasoningEffort: agentDetails.reasoning_effort ?? undefined,
    });
    // RuntimePool now owns workspace/GPG/prompt cleanup and the local session.
    workspace = null;
    localSessionCreated = false;
    promptCreated = false;
    return true;
  } catch (err) {
    logger.error(`Dispatch preparation failed for task ${task.id}: ${(err as Error).message}`);
    await abort();
    return false;
  }
}
