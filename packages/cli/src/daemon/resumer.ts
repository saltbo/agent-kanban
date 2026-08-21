/**
 * Resumer — resume pipeline for rate-limited and rejected sessions.
 *
 * Merges scheduler's resumeOneSession with taskRunner's resumeSession.
 * Restores workspace, validates task state, imports keys, reopens the
 * server session, and spawns the agent with resume=true.
 */

import { existsSync } from "node:fs";
import { AgentClient, type ApiClient } from "../client/index.js";
import { getCredentials } from "../config.js";
import { createLogger } from "../logger.js";
import { getProvider, normalizeRuntime } from "../providers/registry.js";
import { getSessionManager } from "../session/manager.js";
import type { SessionFile } from "../session/types.js";
import { restoreWorkspace } from "../workspace/workspace.js";
import { apiCall, apiCallOptional, cryptoBoundary } from "./boundaries.js";
import { buildAgentEnv, cleanupGnupgHome, setupGnupgHome } from "./dispatcher.js";
import type { RuntimePool } from "./runtimePool.js";

const logger = createLogger("resumer");

/**
 * Resume a saved session (rate-limited or rejected). Returns true on success.
 */
export async function resumeSession(session: SessionFile, message: string, client: ApiClient, pool: RuntimePool): Promise<boolean> {
  const workspace = restoreWorkspace(session.workspace!);
  const taskId = session.taskId!;
  const sessions = getSessionManager();

  if (!existsSync(workspace.cwd)) {
    logger.warn(`Workspace ${workspace.cwd} missing for session ${session.sessionId}, releasing task ${taskId}`);
    await sessions.forceRemove(session.sessionId);
    await apiCallOptional("releaseTask", () => client.releaseTask(taskId));
    return false;
  }

  const task = (await apiCallOptional("getTask", () => client.getTask(taskId))) as { status?: string } | null;
  if (!task || task.status === "cancelled" || task.status === "done") {
    logger.info(`Task ${taskId} is ${task?.status ?? "missing"}, cleaning up resume session`);
    workspace.cleanup();
    await sessions.forceRemove(session.sessionId);
    return false;
  }

  const privateKey = (await cryptoBoundary("importKey", () =>
    crypto.subtle.importKey("jwk", session.privateKeyJwk, { name: "Ed25519" } as any, true, ["sign"]),
  )) as CryptoKey;

  await apiCall("reopenSession", () => client.reopenSession(session.agentId, session.sessionId));

  let gnupgHome: string | null = null;
  if (session.gpgSubkeyId) {
    const gpgData = (await apiCallOptional("getAgentGpgKey", () => client.getAgentGpgKey(session.agentId))) as { armored_private_key: string } | null;
    if (gpgData) gnupgHome = setupGnupgHome(gpgData.armored_private_key);
  }

  const provider = getProvider(normalizeRuntime(session.runtime));
  const apiUrl = getCredentials().apiUrl;
  const agentClient = new AgentClient(apiUrl, session.agentId, session.sessionId, privateKey);
  const agentEnv = buildAgentEnv({
    agentId: session.agentId,
    sessionId: session.sessionId,
    privateKeyJwk: session.privateKeyJwk,
    agentName: session.agentName ?? "Agent",
    agentUsername: session.agentUsername ?? session.agentId,
    gpgSubkeyId: session.gpgSubkeyId ?? null,
    gnupgHome,
  });

  logger.info(`Resuming task ${taskId} (session=${session.sessionId.slice(0, 8)})`);

  await pool.spawnAgent({
    provider,
    taskId,
    sessionId: session.sessionId,
    resumeToken: session.providerResumeToken,
    cwd: workspace.cwd,
    taskContext: message,
    agentClient,
    agentEnv,
    resume: true,
    onCleanup: () => {
      workspace.cleanup();
      cleanupGnupgHome(gnupgHome);
    },
    model: session.model,
    reasoningEffort: session.reasoningEffort,
  });

  await sessions.applyEvent(session.sessionId, { type: "resume_started" });
  return true;
}

/**
 * Single resume entry point with backoff management. Routes through
 * resumeSession and handles transient failures by setting persisted
 * backoff so the next tick doesn't tight-loop retry.
 */
/**
 * Single resume entry point with per-session error isolation. Routes through
 * resumeSession and classifies outcomes:
 *   - success → clear backoff
 *   - resumeSession returned false → set backoff (known non-resumable state)
 *   - TransientError → set backoff (retry next tick)
 *   - TerminalError / other → log, set backoff, do NOT rethrow (one bad
 *     session must not kill the whole tick)
 */
export async function resumeOneSession(session: SessionFile, message: string, client: ApiClient, pool: RuntimePool): Promise<void> {
  const sessions = getSessionManager();
  let ok: boolean;
  try {
    ok = await resumeSession(session, message, client, pool);
  } catch (err) {
    // Per-session error isolation — classify, log, set backoff, continue.
    // This is NOT silent swallowing: the error is logged with full context
    // and the session gets exponential backoff. Unknown errors are included
    // because one corrupt session must not block the entire tick.
    logger.warn(`Resume failed for session ${session.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    ok = false;
  }
  if (ok) {
    await sessions.patch(session.sessionId, { resumeBackoffMs: undefined, resumeAfter: undefined }).catch(() => {});
    return;
  }
  const prev = session.resumeBackoffMs ?? 5000;
  const next = Math.min(prev * 2, 5 * 60_000);
  const resumeAfter = Date.now() + next;
  await sessions.patch(session.sessionId, { resumeBackoffMs: next, resumeAfter }).catch(() => {});
  logger.warn(`Resume backoff for session ${session.sessionId.slice(0, 8)} → ${Math.round(next / 1000)}s`);
}
