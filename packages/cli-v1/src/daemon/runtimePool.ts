/**
 * RuntimePool — registry of live agent handles, event routing, and per-agent lifecycle.
 *
 * Manages the in-memory Map of active AgentProcess records. Routes events from
 * the agent provider to archival/rate-limit/turn-end handlers. Drives post-iterator
 * finalization through the session state machine.
 */

import { cleanupPromptFile } from "../agent/systemPrompt.js";
import type { AgentClient, ApiClient } from "../client/index.js";
import { createLogger } from "../logger.js";
import type { AgentEvent, AgentHandle, AgentProvider } from "../providers/types.js";
import { getSessionManager } from "../session/manager.js";
import { classifyIteratorEnd, type SessionEvent } from "../session/stateMachine.js";
import { apiCallOptional, apiFireAndForget, providerExecute } from "./boundaries.js";
import { classify } from "./errors.js";
import { RuntimeCircuitBreaker } from "./runtimeCircuitBreaker.js";

const logger = createLogger("runtime-pool");

// ---- Types ----

export interface AgentProcess {
  taskId: string;
  sessionId: string;
  handle: AgentHandle;
  providerName: string;
  agentClient: AgentClient;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  rateLimited: boolean;
  resultReceived: boolean;
  /** Cumulative cost reported by the last SDK result event. */
  lastCostUsd: number;
  persistedResumeToken?: string;
  onCleanup?: () => void;
}

export interface RuntimeContext {
  client: ApiClient;
  rateLimitSink: RateLimitSink;
  circuitBreaker: RuntimeCircuitBreaker;
  tunnel: TunnelSink | null;
  isAlive: (taskId: string) => boolean;
}

export interface SpawnRequest {
  provider: AgentProvider;
  taskId: string;
  sessionId: string;
  resumeToken?: string;
  cwd: string;
  taskContext: string;
  agentClient: AgentClient;
  agentEnv: Record<string, string>;
  systemPromptFile?: string;
  resume?: boolean;
  onCleanup?: () => void;
  model?: string;
}

export interface PoolCallbacks {
  onSlotFreed: () => void;
}

export interface AgentFlags {
  taskId: string;
  sessionId: string;
  providerName: string;
  rateLimited: boolean;
  resultReceived: boolean;
  lastCostUsd: number;
}

export interface RateLimitSink {
  onRateLimited: (runtime: string, resetAt: string) => void | Promise<void>;
  onRateLimitResumed: (runtime: string) => void;
}

export interface TunnelSink {
  sendEvent(sessionId: string, event: AgentEvent): void;
}

// ---- RuntimePool class ----

export class RuntimePool {
  private agents = new Map<string, AgentProcess>();
  private client: ApiClient;
  private callbacks: PoolCallbacks;
  private taskTimeoutMs: number;
  private rateLimitSink: RateLimitSink;
  private circuitBreaker: RuntimeCircuitBreaker;
  private tunnel: (TunnelSink & { sendStatus?(sid: string, s: string): void }) | null;

  constructor(
    client: ApiClient,
    callbacks: PoolCallbacks,
    rateLimitSink: RateLimitSink,
    taskTimeoutMs = 2 * 60 * 60 * 1000,
    tunnel?: TunnelSink | null,
    circuitBreaker: RuntimeCircuitBreaker = new RuntimeCircuitBreaker(),
  ) {
    this.client = client;
    this.callbacks = callbacks;
    this.rateLimitSink = rateLimitSink;
    this.circuitBreaker = circuitBreaker;
    this.taskTimeoutMs = taskTimeoutMs;
    this.tunnel = tunnel ?? null;
  }

  get activeCount(): number {
    return this.agents.size;
  }

  activeCountForRuntime(runtime: string): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.providerName === runtime) count++;
    }
    return count;
  }

  hasTask(taskId: string): boolean {
    return this.agents.has(taskId);
  }

  getActiveTaskIds(): string[] {
    return [...this.agents.keys()];
  }

  async spawnAgent(req: SpawnRequest): Promise<void> {
    const { provider, taskId, sessionId, agentClient } = req;

    const handle: AgentHandle = await providerExecute(provider.name, () =>
      provider.execute({
        sessionId,
        resumeToken: req.resumeToken,
        cwd: req.cwd,
        env: { ...(process.env as Record<string, string>), ...req.agentEnv },
        taskContext: req.taskContext,
        systemPromptFile: req.systemPromptFile,
        model: req.model,
        resume: req.resume,
      }),
    );

    const agent: AgentProcess = {
      taskId,
      sessionId,
      handle,
      providerName: provider.name,
      agentClient,
      rateLimited: false,
      resultReceived: false,
      lastCostUsd: 0,
      onCleanup: req.onCleanup,
    };
    this.agents.set(taskId, agent);

    this.tunnel?.sendStatus?.(sessionId, "working");

    if (this.taskTimeoutMs > 0) {
      agent.timeoutTimer = setTimeout(() => {
        logger.warn(`Agent for task ${taskId} exceeded timeout (${Math.round(this.taskTimeoutMs / 60000)}m), killing`);
        agent.handle.abort().catch((e) => logger.warn(`Abort during timeout failed: ${errMessage(e)}`));
      }, this.taskTimeoutMs);
    }

    logger.info(`Started ${provider.name} (session=${sessionId}) for task ${taskId} in ${req.cwd}`);

    this.runEventLoop(agent);
  }

  async sendToAgent(taskId: string, message: string): Promise<void> {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    await agent.handle.send(message);
  }

  async sendToSession(sessionId: string, message: string): Promise<boolean> {
    for (const agent of this.agents.values()) {
      if (agent.sessionId === sessionId) {
        await agent.handle.send(message);
        return true;
      }
    }
    return false;
  }

  async killTask(taskId: string): Promise<void> {
    const agent = this.agents.get(taskId);
    if (!agent) return;
    logger.info(`Killing agent for cancelled task ${taskId}`);
    this.agents.delete(taskId);
    await agent.handle.abort().catch((e) => logger.warn(`Abort failed: ${errMessage(e)}`));
    await finalizeCancelled(agent, this.runtimeCtx());
    this.callbacks.onSlotFreed();
  }

  async killAll(): Promise<void> {
    const entries = [...this.agents.entries()];
    for (const [taskId, agent] of entries) {
      logger.info(`Killing agent for task ${taskId}`);
      this.agents.delete(taskId);
      await agent.handle.abort().catch((e) => logger.warn(`Abort failed: ${errMessage(e)}`));
      await this.client
        .closeSession(agent.agentClient.getAgentId(), agent.agentClient.getSessionId())
        .catch((e) => logger.warn(`Failed to close session ${agent.sessionId}: ${errMessage(e)}`));
      await this.client.releaseTask(taskId).catch((e) => logger.warn(`Failed to release task ${taskId}: ${errMessage(e)}`));
    }
  }

  private runEventLoop(agent: AgentProcess): void {
    const ctx = this.runtimeCtx();
    const loop = async () => {
      let result: { crashed: boolean; error?: unknown };
      try {
        result = await consumeEvents(agent, ctx);
      } catch (err) {
        result = { crashed: true, error: err };
      }
      if (!this.agents.has(agent.taskId)) return; // killTask ran
      this.agents.delete(agent.taskId);
      try {
        await finalize(agent, result, ctx);
      } finally {
        this.callbacks.onSlotFreed();
      }
    };
    loop().catch((e) => logger.error(`Event loop error/${agent.taskId}: ${errMessage(e)}`));
  }

  private runtimeCtx(): RuntimeContext {
    return {
      client: this.client,
      rateLimitSink: this.rateLimitSink,
      circuitBreaker: this.circuitBreaker,
      tunnel: this.tunnel,
      isAlive: (taskId) => this.agents.has(taskId),
    };
  }
}

// ---- Event routing ----

async function routeEvent(
  agent: AgentFlags,
  event: AgentEvent,
  agentClient: AgentClient,
  rateLimitSink: RateLimitSink,
  tunnel: TunnelSink | null,
): Promise<void> {
  tunnel?.sendEvent(agent.sessionId, event);

  switch (event.type) {
    case "turn.rate_limit":
      await routeRateLimit(agent, event, rateLimitSink);
      return;
    case "turn.error":
      logger.warn(`Agent error on task ${agent.taskId} (${agent.providerName}): ${event.detail}`);
      return;
    case "message":
      archiveMessage(agentClient, agent.taskId, event);
      return;
    case "block.done":
      archiveBlock(agentClient, agent.taskId, event);
      return;
    case "turn.end":
      routeTurnEnd(agent, event, agentClient);
      return;
    default:
      return;
  }
}

async function routeRateLimit(agent: AgentFlags, event: Extract<AgentEvent, { type: "turn.rate_limit" }>, sink: RateLimitSink): Promise<void> {
  const runtime = agent.providerName;
  if (event.status === "rejected") {
    const mainReset = event.resetAt;
    const overageReset = event.overage?.status === "rejected" ? event.overage.resetAt : undefined;
    const resetTimestamps = [mainReset, overageReset].filter((x): x is string => !!x);
    const pauseUntil =
      resetTimestamps.length > 0
        ? resetTimestamps.reduce((a, b) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b))
        : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    logger.warn(
      `Rate limited on task ${agent.taskId} (${runtime}), pausing until ${pauseUntil}${event.isUsingOverage ? " — agent continues via overage" : ""}`,
    );
    agent.rateLimited = true;
    // Persist first, then notify the in-memory sink. Reverse order would leave
    // a crash window: if the daemon died between sink update and disk write,
    // the session would come back up without resumeAfter and be stranded —
    // exactly the bug this fix exists to prevent.
    const resumeAfter = new Date(pauseUntil).getTime();
    await getSessionManager()
      .patch(agent.sessionId, { resumeAfter })
      .catch((e) => logger.warn(`Failed to persist resumeAfter for ${agent.sessionId.slice(0, 8)}: ${errMessage(e)}`));
    await sink.onRateLimited(runtime, pauseUntil);
    return;
  }
  if (event.isUsingOverage) {
    logger.info(`Task ${agent.taskId} (${runtime}) now running on overage, scheduler stays paused`);
    return;
  }
  logger.info(`Rate limit cleared for ${runtime}`);
  agent.rateLimited = false;
  sink.onRateLimitResumed(runtime);
}

/**
 * Handle a turn.end (SDK result) event.
 *
 * A single query() call can yield multiple result events when background tasks
 * are in flight — each segment gets its own result. This handler:
 *   1. Reports per-segment token usage (server accumulates correctly).
 *   2. Stores the cumulative cost (overwritten each time; finalize reports once).
 *   3. Marks resultReceived so finalize knows a result was produced.
 *
 * Task status check and cost reporting happen in finalize() after the iterator
 * ends, not here — intermediate results don't reflect the final task state.
 */
function routeTurnEnd(agent: AgentFlags, event: Extract<AgentEvent, { type: "turn.end" }>, agentClient: AgentClient): void {
  const cost = event.cost || 0;
  const usage = event.usage || {};

  logger.info(`Turn ended for task ${agent.taskId} (${agent.providerName}): cumulative_cost=$${cost.toFixed(4)}`);

  // Tokens are per-segment — safe to accumulate on the server.
  // Cost is cumulative across segments — store it and report once in finalize.
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens > 0) {
    apiFireAndForget(
      "updateSessionUsage",
      () =>
        agentClient.updateSessionUsage(agentClient.getAgentId(), agentClient.getSessionId(), {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cache_creation_tokens: cacheCreationTokens,
          cost_micro_usd: 0,
        }),
      (msg) => logger.error(`Failed to report usage for task ${agent.taskId}: ${msg}`),
    );
  }

  agent.resultReceived = true;
  agent.lastCostUsd = cost;
}

function archiveMessage(agentClient: AgentClient, taskId: string, event: Extract<AgentEvent, { type: "message" }>): void {
  const texts = event.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
  if (texts.length === 0) return;
  apiFireAndForget(
    "sendMessage",
    () => agentClient.sendMessage(taskId, { sender_type: "agent", sender_id: agentClient.getAgentId(), content: texts.join("\n") }),
    (msg) => logger.error(`Failed to send message for task ${taskId}: ${msg}`),
  );
}

function archiveBlock(agentClient: AgentClient, taskId: string, event: Extract<AgentEvent, { type: "block.done" }>): void {
  const block = event.block;
  if (block.type !== "text" || !block.text) return;
  const text = block.text;
  apiFireAndForget(
    "sendMessage",
    () => agentClient.sendMessage(taskId, { sender_type: "agent", sender_id: agentClient.getAgentId(), content: text }),
    (msg) => logger.error(`Failed to send message for task ${taskId}: ${msg}`),
  );
}

// ---- Agent lifecycle ----

async function consumeEvents(agent: AgentProcess, ctx: RuntimeContext): Promise<{ crashed: boolean; error?: unknown }> {
  const flags: AgentFlags = {
    taskId: agent.taskId,
    sessionId: agent.sessionId,
    providerName: agent.providerName,
    rateLimited: agent.rateLimited,
    resultReceived: agent.resultReceived,
    lastCostUsd: agent.lastCostUsd,
  };

  try {
    for await (const event of agent.handle.events) {
      if (!ctx.isAlive(agent.taskId)) return { crashed: false };
      await persistResumeToken(agent);
      await routeEvent(flags, event, agent.agentClient, ctx.rateLimitSink, ctx.tunnel);
    }
    return { crashed: false };
  } catch (err) {
    return { crashed: true, error: err };
  } finally {
    // Sync mutable flags back — routeEvent receives AgentFlags (not AgentProcess)
    // to decouple event routing from the full process record.
    agent.rateLimited = flags.rateLimited;
    agent.resultReceived = flags.resultReceived;
    agent.lastCostUsd = flags.lastCostUsd;
  }
}

async function persistResumeToken(agent: AgentProcess): Promise<void> {
  const token = agent.handle.getResumeToken?.();
  if (!token || token === agent.persistedResumeToken) return;
  agent.persistedResumeToken = token;
  await getSessionManager()
    .patch(agent.sessionId, { providerResumeToken: token })
    .catch((e) => logger.warn(`Failed to persist resume token for ${agent.sessionId.slice(0, 8)}: ${errMessage(e)}`));
}

async function finalize(agent: AgentProcess, opts: { crashed: boolean; error?: unknown }, ctx: RuntimeContext): Promise<void> {
  const { taskId, sessionId } = agent;
  const sessions = getSessionManager();

  clearTimer(agent);
  cleanupPromptFile(sessionId);

  apiFireAndForget(
    "closeSession",
    () => ctx.client.closeSession(agent.agentClient.getAgentId(), sessionId),
    (msg) => logger.warn(`Failed to close session ${sessionId}: ${msg}`),
  );

  let transient = false;
  if (opts.crashed) {
    const err = opts.error as { exitCode?: number; stderr?: string; message?: string } | undefined;
    transient = classify(opts.error, "iterator").kind === "transient";
    if (transient) {
      logger.warn(`Agent hit transient error on task ${taskId} (${agent.providerName}): ${err?.message ?? ""}`);
    } else {
      logger.warn(`Agent crashed on task ${taskId} (${agent.providerName}, exit ${err?.exitCode ?? "?"}): ${err?.message ?? ""}`);
    }
    if (err?.stderr) logger.warn(`stderr: ${err.stderr}`);
  } else {
    logger.info(`Agent finished task ${taskId} (${agent.providerName}): cost=$${agent.lastCostUsd.toFixed(4)}`);
  }

  // Report cumulative cost once now that the iterator is done.
  if (agent.lastCostUsd > 0) {
    apiFireAndForget(
      "updateSessionUsage:cost",
      () =>
        agent.agentClient.updateSessionUsage(agent.agentClient.getAgentId(), agent.agentClient.getSessionId(), {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_micro_usd: Math.round(agent.lastCostUsd * 1_000_000),
        }),
      (msg) => logger.error(`Failed to report cost for task ${taskId}: ${msg}`),
    );
  }

  // Agent produced a result → preserve worktree. The work product lives in
  // the worktree and must survive for review, reject-resume, or completion
  // cleanup. The daemon loop handles all post-finalize lifecycle:
  //   - in_review → wait for human review
  //   - in_progress + rejected → resume agent
  //   - in_progress + no reject → release (agent forgot to submit review)
  //   - done/cancelled → cleanup
  const taskInReview = agent.resultReceived && !opts.crashed;
  const providerResumeToken = agent.handle.getResumeToken?.();

  const event: SessionEvent = classifyIteratorEnd({
    resultReceived: agent.resultReceived,
    rateLimited: agent.rateLimited,
    taskInReview,
    crashed: opts.crashed,
    transient,
  });

  const next = await sessions.applyEvent(sessionId, event, providerResumeToken ? { providerResumeToken } : undefined).catch((e) => {
    logger.error(`State transition failed for ${sessionId}: ${errMessage(e)}`);
    return null;
  });

  const nextStatus = next?.status ?? "terminal";

  if (nextStatus === "completing") {
    await handleCompletingTask(agent, opts, ctx);
    runCleanup(agent, ctx.tunnel);
    await sessions.applyEvent(sessionId, { type: "cleanup_done" }).catch((e) => {
      logger.warn(`Cleanup transition failed for ${sessionId}: ${errMessage(e)}`);
    });
  } else if (nextStatus === "in_review") {
    ctx.circuitBreaker.recordWorkflowEntered(agent.providerName);
    (ctx.tunnel as TunnelSink & { sendStatus?: (sid: string, s: string) => void })?.sendStatus?.(sessionId, "done");
    logger.info(`Task ${taskId} in review, preserving worktree`);
  } else if (nextStatus === "rate_limited") {
    if (transient) {
      const backoffMs = 30_000;
      await sessions.patch(sessionId, { resumeBackoffMs: backoffMs, resumeAfter: Date.now() + backoffMs }).catch(() => {});
      logger.warn(`Transient crash on task ${taskId}, suspending with ${backoffMs / 1000}s backoff`);
    } else {
      logger.warn(`Agent for task ${taskId} (${agent.providerName}) exited while rate-limited, suspending`);
    }
  }
}

async function handleCompletingTask(agent: AgentProcess, opts: { crashed: boolean; error?: unknown }, ctx: RuntimeContext): Promise<void> {
  const { taskId } = agent;
  const task = (await apiCallOptional("getTask", () => ctx.client.getTask(taskId))) as { status?: string } | null;
  const reason = opts.crashed ? `agent crashed: ${errMessage(opts.error)}` : "agent exited before submitting review";

  if (!task) {
    logger.warn(`Task ${taskId} missing during finalize; cleaning up session without release`);
    return;
  }

  if (task.status === "todo") {
    ctx.circuitBreaker.recordPreClaimFailure(agent.providerName, taskId, reason);
    logger.warn(`Task ${taskId} remained todo after ${agent.providerName} session ended; treating as pre-claim runtime failure`);
    return;
  }

  if (task.status === "in_progress") {
    ctx.circuitBreaker.recordWorkflowEntered(agent.providerName);
    if (opts.crashed) {
      logger.warn(`Releasing task ${taskId}: agent crashed`);
    } else {
      logger.info(`Releasing task ${taskId}: agent finished without moving task to review`);
    }
    apiFireAndForget(
      "releaseTask",
      () => ctx.client.releaseTask(taskId),
      (msg) => logger.warn(`Failed to release task ${taskId}: ${msg}`),
    );
    return;
  }

  if (task.status === "in_review" || task.status === "done" || task.status === "cancelled") {
    ctx.circuitBreaker.recordWorkflowEntered(agent.providerName);
    logger.info(`Task ${taskId} is ${task.status}; cleaning up session without release`);
    return;
  }

  logger.warn(`Task ${taskId} has unexpected status ${task.status ?? "unknown"}; cleaning up session without release`);
}

async function finalizeCancelled(agent: AgentProcess, ctx: RuntimeContext): Promise<void> {
  const sessions = getSessionManager();
  cleanupPromptFile(agent.sessionId);

  await sessions.applyEvent(agent.sessionId, { type: "task_cancelled" }).catch((e) => {
    logger.warn(`task_cancelled transition failed for ${agent.sessionId}: ${errMessage(e)}`);
  });
  runCleanup(agent, ctx.tunnel);
  await sessions.applyEvent(agent.sessionId, { type: "cleanup_done" }).catch((e) => {
    logger.warn(`cleanup_done transition failed for ${agent.sessionId}: ${errMessage(e)}`);
  });
  apiFireAndForget(
    "closeSession",
    () => ctx.client.closeSession(agent.agentClient.getAgentId(), agent.sessionId),
    (msg) => logger.warn(`Failed to close session ${agent.sessionId}: ${msg}`),
  );
}

// ---- Helpers ----

function runCleanup(agent: AgentProcess, tunnel: TunnelSink | null): void {
  (tunnel as TunnelSink & { sendStatus?: (sid: string, s: string) => void })?.sendStatus?.(agent.sessionId, "done");
  agent.onCleanup?.();
}

function clearTimer(agent: AgentProcess): void {
  if (agent.timeoutTimer) {
    clearTimeout(agent.timeoutTimer);
    agent.timeoutTimer = undefined;
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
