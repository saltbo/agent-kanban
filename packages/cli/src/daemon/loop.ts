/**
 * DaemonLoop — the tick orchestrator.
 *
 * Owns the setTimeout-based poll loop. Each tick runs ordered phases:
 * killCancelled -> reap -> reviewWatch -> resumeRateLimit -> dispatch.
 *
 * Includes orphan reaping (detects worker sessions not held by RuntimePool)
 * and review watching (detects rejected/completed/deleted reviews).
 *
 * The ONLY catch in the whole daemon is at the setTimeout level:
 * tick().catch(handleTickError) — this is the top-level boundary.
 */

import { type ApiClient, ApiError } from "../client/index.js";
import { createLogger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";
import { getSessionManager } from "../session/manager.js";
import type { SessionFile } from "../session/types.js";
import { canSafelyDiscardOrphanWorkspace, cleanupWorkspace } from "../workspace/workspace.js";
import { apiCallOptional, cleanupSync } from "./boundaries.js";
import { dispatchTasks } from "./dispatcher.js";
import { CleanupError } from "./errors.js";
import type { PrMonitor } from "./prMonitor.js";
import { type RateLimiter } from "./rateLimiter.js";
import { resumeOneSession } from "./resumer.js";
import { RuntimeCircuitBreaker } from "./runtimeCircuitBreaker.js";
import type { RuntimePool } from "./runtimePool.js";

const logger = createLogger("loop");

const RATE_LIMIT_RESUME_PROMPT = "Rate limit window has reset. Continue working on the task where you left off.";

// Idle exponential backoff: each tick that does no work slows the next
// tick down by this multiplier up to MAX_IDLE_BACKOFF_MS. Any real event
// — a dispatched task, a reap, a slot freed, a rate-limit resume —
// snaps the daemon back to the base pollInterval.
const IDLE_BACKOFF_MULTIPLIER = 1.5;
const MAX_IDLE_BACKOFF_MS = 120_000;

export interface LoopOpts {
  maxConcurrent: number;
  pollInterval: number;
}

// ---- DaemonLoop class ----

export class DaemonLoop {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private errorBackoffMs: number;
  private idleBackoffMs: number;
  private sessions = getSessionManager();

  constructor(
    private client: ApiClient,
    private pool: RuntimePool,
    private rateLimiter: RateLimiter,
    private prMonitor: PrMonitor,
    private opts: LoopOpts,
    private circuitBreaker: RuntimeCircuitBreaker = new RuntimeCircuitBreaker(),
  ) {
    this.errorBackoffMs = opts.pollInterval;
    this.idleBackoffMs = opts.pollInterval;
  }

  start(): void {
    this.running = true;
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  onSlotFreed(): void {
    this.resetIdleBackoff();
    this.schedulePoll(this.opts.pollInterval);
  }

  /**
   * Resume rate-limited sessions for a runtime whose window just expired.
   * Called by RateLimiter's onResumed callback.
   */
  async resumeRateLimitedSessions(runtime: string): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    for (const s of this.sessions.list({ type: "worker", status: "rate_limited" })) {
      if (s.runtime !== runtime) continue;
      if (this.pool.activeCountForRuntime(s.runtime) >= this.opts.maxConcurrent) return;
      if (!s.taskId || this.pool.hasTask(s.taskId)) continue;
      if (s.resumeAfter && s.resumeAfter > now) continue;
      await resumeOneSession(s, RATE_LIMIT_RESUME_PROMPT, this.client, this.pool);
    }
    this.resetIdleBackoff();
    this.schedulePoll(0);
  }

  private resetIdleBackoff(): void {
    this.idleBackoffMs = this.opts.pollInterval;
  }

  private bumpIdleBackoff(): void {
    this.idleBackoffMs = Math.min(this.idleBackoffMs * IDLE_BACKOFF_MULTIPLIER, MAX_IDLE_BACKOFF_MS);
  }

  /**
   * Resume rate_limited sessions whose backoff timer has expired.
   * Covers transient crash recovery (not driven by RateLimiter timer).
   */
  private async resumeBackoffSessions(): Promise<void> {
    const now = Date.now();
    for (const s of this.sessions.list({ type: "worker", status: "rate_limited" })) {
      if (this.pool.activeCountForRuntime(s.runtime) >= this.opts.maxConcurrent) continue;
      if (!s.taskId || this.pool.hasTask(s.taskId)) continue;
      if (!s.resumeAfter || s.resumeAfter > now) continue;
      await resumeOneSession(s, RATE_LIMIT_RESUME_PROMPT, this.client, this.pool);
    }
  }

  /** Pick the shorter of idle backoff and the nearest rate-limit resume. */
  private nextPollDelay(): number {
    const now = Date.now();
    let earliest = Infinity;
    for (const s of this.sessions.list({ type: "worker", status: "rate_limited" })) {
      if (s.resumeAfter && s.resumeAfter > now) earliest = Math.min(earliest, s.resumeAfter - now);
    }
    const rateLimitDelay = earliest === Infinity ? Infinity : Math.max(earliest, 1000);
    return Math.min(this.idleBackoffMs, rateLimitDelay);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.tick().catch((e) => this.handleTickError(e)), delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    // Pool size can shrink during the reap phases if any orphan / cancelled /
    // cleanup-pending session reaches a terminal state. Treating that as work
    // keeps the daemon responsive right after a cleanup.
    const activeBefore = this.pool.activeCount;

    await this.killCancelledTasks();
    await reapOrphanWorkerSessions(this.sessions, this.pool, this.client, this.circuitBreaker);
    await reapCleanupPending(this.sessions);
    await checkRejectedReviews(
      this.sessions,
      this.pool,
      this.client,
      (s, msg) => resumeOneSession(s, msg, this.client, this.pool),
      this.opts.maxConcurrent,
    );

    await this.resumeBackoffSessions();

    const reapedOrResumed = this.pool.activeCount !== activeBefore;

    const dispatched = await dispatchTasks(
      this.client,
      this.pool,
      this.rateLimiter,
      this.prMonitor,
      {
        maxConcurrent: this.opts.maxConcurrent,
        pollInterval: this.opts.pollInterval,
      },
      this.circuitBreaker,
    );

    if (dispatched || reapedOrResumed) {
      this.resetIdleBackoff();
    } else {
      this.bumpIdleBackoff();
    }

    this.errorBackoffMs = this.opts.pollInterval;
    this.schedulePoll(this.nextPollDelay());
  }

  private async killCancelledTasks(): Promise<void> {
    for (const taskId of this.pool.getActiveTaskIds()) {
      const task = (await apiCallOptional("getTask", () => this.client.getTask(taskId))) as { status?: string } | null;
      if (task?.status === "cancelled") await this.pool.killTask(taskId);
    }
  }

  private handleTickError(err: any): void {
    if (err instanceof ApiError && err.status === 429) {
      logger.warn("Rate limited, backing off");
      this.errorBackoffMs = Math.min(Math.max(this.errorBackoffMs * 2, 30000), 60000);
    } else {
      logger.warn(`Poll error: ${err.message}${err.cause ? ` — cause: ${err.cause.message ?? err.cause}` : ""}`);
      this.errorBackoffMs = Math.min(this.errorBackoffMs * 2, 60000);
    }
    this.schedulePoll(this.errorBackoffMs);
  }
}

// ---- Orphan reaping ----

/**
 * Find active worker sessions not in the pool and reap them.
 *
 * Decision tree per orphan:
 *   - task deleted (404)        -> cleanup workspace + remove session
 *   - task done / cancelled     -> cleanup workspace + remove session
 *   - task still viable         -> release task + cleanup + remove session
 */
export async function reapOrphanWorkerSessions(
  sessions: SessionManager,
  pool: RuntimePool,
  client: {
    getTask(id: string): Promise<unknown>;
    releaseTask(id: string): Promise<unknown>;
    closeSession(agentId: string, sessionId: string): Promise<unknown>;
  },
  circuitBreaker?: RuntimeCircuitBreaker,
): Promise<void> {
  for (const s of sessions.list({ type: "worker", status: "active" })) {
    if (!s.taskId || pool.hasTask(s.taskId)) continue;
    if (s.workspace && !canSafelyDiscardOrphanWorkspace(s.workspace)) {
      logger.warn(`Preserving orphan session ${s.sessionId.slice(0, 8)} and workspace ${s.workspace.cwd}; manual recovery is required`);
      continue;
    }

    const task = (await apiCallOptional("getTask", () => client.getTask(s.taskId!))) as { status?: string } | null;

    if (!task) {
      logger.warn(`Task ${s.taskId} not found (deleted), reaping orphan session`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await completeTerminal(sessions, s);
      continue;
    }

    if (task.status === "done" || task.status === "cancelled") {
      logger.info(`Reaping orphan worker session for task ${s.taskId} (status=${task.status})`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await completeTerminal(sessions, s);
      continue;
    }

    if (task.status === "todo") {
      circuitBreaker?.recordPreClaimFailure(s.runtime, s.taskId, "orphan session found before task was claimed");
      logger.warn(`Reaping pre-claim orphan session for task ${s.taskId} (runtime=${s.runtime}) without release`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await completeTerminal(sessions, s);
      continue;
    }

    if (task.status === "in_progress") {
      await apiCallOptional("releaseOrphanTask", () => client.releaseTask(s.taskId!));
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      logger.info(`Released orphan task ${s.taskId} and reaped its session`);
    } else {
      logger.warn(`Reaping orphan session for task ${s.taskId} with unexpected status ${task.status ?? "unknown"} without release`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
    }
    await completeTerminal(sessions, s);
  }
}

/**
 * Retry cleanup for sessions that had a prior cleanup failure.
 * These are sessions in "completing" state with cleanupPending=true.
 */
export async function reapCleanupPending(sessions: SessionManager): Promise<void> {
  for (const s of sessions.list({ type: "worker", status: "completing" as any })) {
    if (!s.cleanupPending) continue;
    logger.info(`Retrying cleanup for session ${s.sessionId.slice(0, 8)}`);
    try {
      if (s.workspace) cleanupSync("workspace-retry", () => cleanupWorkspace(s.workspace!));
      await sessions.applyEvent(s.sessionId, { type: "cleanup_done" });
    } catch (err) {
      logger.warn(`Cleanup retry failed for ${s.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      // Leave cleanupPending=true, retry next tick
    }
  }
}

/**
 * Drive an active orphan session through the state machine to terminal.
 * If workspace cleanup fails (CleanupError), marks the session with
 * cleanupPending so reapCleanupPending retries on the next tick.
 */
async function completeTerminal(sessions: SessionManager, s: SessionFile): Promise<void> {
  await sessions.applyEvent(s.sessionId, { type: "orphan_detected" });
  try {
    if (s.workspace) cleanupSync("workspace", () => cleanupWorkspace(s.workspace!));
    await sessions.applyEvent(s.sessionId, { type: "cleanup_done" });
  } catch (err) {
    if (err instanceof CleanupError) {
      logger.warn(`Workspace cleanup failed for ${s.sessionId.slice(0, 8)}, will retry: ${err.message}`);
      await sessions.patch(s.sessionId, { cleanupPending: true });
      return;
    }
    // Non-cleanup error (shouldn't happen in practice) — still try to terminate
    logger.error(`Unexpected error in completeTerminal for ${s.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    await sessions.applyEvent(s.sessionId, { type: "cleanup_done" }).catch(() => {});
  }
}

// ---- Review watching ----

type ResumeCallback = (session: SessionFile, message: string) => Promise<void>;

/**
 * Scan in_review sessions and handle rejected reviews, completed tasks,
 * and deleted tasks.
 */
export async function checkRejectedReviews(
  sessions: SessionManager,
  pool: RuntimePool,
  client: ApiClient,
  resumeOne: ResumeCallback,
  maxConcurrent: number,
): Promise<void> {
  const now = Date.now();
  for (const s of sessions.list({ type: "worker", status: "in_review" })) {
    if (pool.activeCountForRuntime(s.runtime) >= maxConcurrent) continue;
    if (!s.taskId || pool.hasTask(s.taskId)) continue;
    if (s.resumeAfter && s.resumeAfter > now) continue;

    const task = (await apiCallOptional("getTask", () => client.getTask(s.taskId!))) as { status?: string } | null;

    if (!task) {
      logger.warn(`Task ${s.taskId} not found (deleted), cleaning up review session`);
      await completeTerminalFromReview(sessions, s, { type: "task_deleted" });
      continue;
    }

    if (task.status === "done" || task.status === "cancelled") {
      logger.info(`Cleaning up review session for task ${s.taskId} (task status=${task.status})`);
      await completeTerminalFromReview(sessions, s, { type: "task_cancelled" });
      continue;
    }

    if (task.status === "in_progress") {
      const notes = (await client.getTaskNotes(s.taskId)) as Array<{ action?: string; detail?: string }>;
      const rejectLog = [...notes].reverse().find((l) => l.action === "rejected");
      if (rejectLog) {
        const reason = rejectLog.detail || "No reason provided";
        const message = `Task rejected. Reason: ${reason}\n\nPlease fix the issues and submit for review again.`;
        await resumeOne(s, message);
      } else {
        // Agent finished with result but never submitted for review — release.
        logger.info(`Task ${s.taskId} in_progress without reject, releasing orphan review session`);
        await completeTerminalFromReview(sessions, s, { type: "task_cancelled" });
      }
    }
  }
}

/** Drive an in_review session through the state machine to terminal. */
async function completeTerminalFromReview(
  sessions: SessionManager,
  s: SessionFile,
  event: { type: "task_cancelled" | "task_deleted" },
): Promise<void> {
  await sessions.applyEvent(s.sessionId, event).catch((e) => {
    logger.warn(`Review session event failed for ${s.sessionId}: ${errMessage(e)}`);
  });
  if (s.workspace) cleanupWorkspace(s.workspace);
  await sessions.applyEvent(s.sessionId, { type: "cleanup_done" }).catch((e) => {
    logger.warn(`Review session cleanup failed for ${s.sessionId}: ${errMessage(e)}`);
  });
}

// ---- Helpers ----

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
