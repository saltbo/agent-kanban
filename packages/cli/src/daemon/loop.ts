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

import { randomUUID } from "node:crypto";
import type { TaskFailure } from "@agent-kanban/shared";
import { type ApiClient, ApiError } from "../client/index.js";
import { createLogger } from "../logger.js";
import type { SessionManager } from "../session/manager.js";
import { getSessionManager } from "../session/manager.js";
import type { SessionFile } from "../session/types.js";
import { cleanupWorkspace, type WorkspaceCleanupReason } from "../workspace/workspace.js";
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
const ERROR_RETRY_PROMPT = "The task was explicitly retried after a runtime error. Continue from the preserved workspace and context.";

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
    await checkErroredSessions(
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
    getTaskNotes(id: string): Promise<unknown>;
    failTask(id: string, body: TaskFailure & { session_id?: string; runtime?: string; attempt_id: string }): Promise<unknown>;
    closeSession(agentId: string, sessionId: string): Promise<unknown>;
  },
  circuitBreaker?: RuntimeCircuitBreaker,
): Promise<void> {
  for (const s of sessions.list({ type: "worker", status: "active" })) {
    if (!s.taskId || pool.hasTask(s.taskId)) continue;
    const task = (await apiCallOptional("getTask", () => client.getTask(s.taskId!))) as { status?: string } | null;

    if (!task) {
      logger.warn(`Task ${s.taskId} not found (deleted), reaping orphan session`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await completeTerminal(sessions, s, "task_deleted");
      continue;
    }

    if (task.status === "done" || task.status === "cancelled") {
      logger.info(`Reaping orphan worker session for task ${s.taskId} (status=${task.status})`);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await completeTerminal(sessions, s, task.status === "done" ? "task_done" : "task_cancelled");
      continue;
    }

    if (task.status === "todo") {
      circuitBreaker?.recordPreClaimFailure(s.runtime, s.taskId, "orphan session found before task was claimed");
      const failure = {
        category: "protocol",
        code: "ORPHANED_BEFORE_CLAIM",
        message: "Daemon restarted or lost the runtime before the assigned task was claimed",
        retryable: true,
      } as const;
      const failureAttemptId = randomUUID();
      await sessions.patch(s.sessionId, { failureAttemptId, lastFailure: failure });
      await apiCallOptional("failPreClaimOrphanTask", () =>
        client.failTask(s.taskId!, { ...failure, session_id: s.sessionId, runtime: s.runtime, attempt_id: failureAttemptId }),
      );
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await sessions.applyEvent(s.sessionId, { type: "iterator_failed" }, { lastFailure: failure, failureAttemptId, errorAt: Date.now() });
      logger.warn(`Moved pre-claim orphan task ${s.taskId} to error queue and preserved its workspace`);
      continue;
    }

    if (task.status === "in_progress") {
      const failure = {
        category: "protocol",
        code: "ORPHANED_RUNTIME",
        message: "Daemon restarted or lost the live runtime before the task reached review",
        retryable: true,
      } as const;
      const failureAttemptId = randomUUID();
      await sessions.patch(s.sessionId, { failureAttemptId, lastFailure: failure });
      await apiCallOptional("failOrphanTask", () =>
        client.failTask(s.taskId!, { ...failure, session_id: s.sessionId, runtime: s.runtime, attempt_id: failureAttemptId }),
      );
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await sessions.applyEvent(s.sessionId, { type: "iterator_failed" }, { lastFailure: failure, failureAttemptId, errorAt: Date.now() });
      logger.warn(`Moved orphan task ${s.taskId} to error queue and preserved its workspace`);
    } else if (task.status === "in_review") {
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await sessions.applyEvent(s.sessionId, { type: "iterator_done_with_result", taskInReview: true });
      logger.info(`Recovered orphan session for task ${s.taskId} in review; preserving workspace`);
    } else if (task.status === "error") {
      const failure = {
        category: "unknown",
        code: "RECOVERED_ERROR_STATE",
        message: "Recovered server-side error state after daemon restart",
        retryable: true,
      } as const;
      const notes = (await apiCallOptional("getOrphanTaskNotes", () => client.getTaskNotes(s.taskId!))) as Array<{
        action?: string;
        detail?: string | null;
      }> | null;
      const latestFailed = [...(notes ?? [])].reverse().find((note) => note.action === "failed" && failureActionAttemptId(note.detail));
      const failureAttemptId = failureActionAttemptId(latestFailed?.detail);
      await apiCallOptional("closeOrphanSession", () => client.closeSession(s.agentId, s.sessionId));
      await sessions.applyEvent(
        s.sessionId,
        { type: "iterator_failed" },
        {
          lastFailure: failure,
          failureAttemptId: failureAttemptId ?? undefined,
          errorAt: Date.now(),
        },
      );
      logger.warn(`Recovered orphan error session for task ${s.taskId}; preserving workspace`);
    } else {
      logger.warn(`Preserving orphan session for task ${s.taskId} with status ${task.status ?? "unknown"}`);
    }
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
      if (!s.cleanupReason) {
        logger.warn(`Cleanup retry for ${s.sessionId.slice(0, 8)} has no terminal reason; preserving workspace`);
        continue;
      }
      if (s.workspace) cleanupSync("workspace-retry", () => cleanupWorkspace(s.workspace!, s.cleanupReason!));
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
async function completeTerminal(sessions: SessionManager, s: SessionFile, reason: WorkspaceCleanupReason): Promise<void> {
  await sessions.applyEvent(s.sessionId, { type: "orphan_detected" });
  try {
    if (s.workspace) cleanupSync("workspace", () => cleanupWorkspace(s.workspace!, reason));
    await sessions.applyEvent(s.sessionId, { type: "cleanup_done" });
  } catch (err) {
    if (err instanceof CleanupError) {
      logger.warn(`Workspace cleanup failed for ${s.sessionId.slice(0, 8)}, will retry: ${err.message}`);
      await sessions.patch(s.sessionId, { cleanupPending: true, cleanupReason: reason });
      return;
    }
    // Non-cleanup error (shouldn't happen in practice) — still try to terminate
    logger.error(`Unexpected error in completeTerminal for ${s.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    await sessions.applyEvent(s.sessionId, { type: "cleanup_done" }).catch(() => {});
  }
}

// ---- Review watching ----

type ResumeCallback = (session: SessionFile, message: string) => Promise<boolean>;

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
      await completeTerminalFromReview(sessions, s, { type: "task_deleted" }, "task_deleted");
      continue;
    }

    if (task.status === "done" || task.status === "cancelled") {
      logger.info(`Cleaning up review session for task ${s.taskId} (task status=${task.status})`);
      await completeTerminalFromReview(sessions, s, { type: "task_cancelled" }, task.status === "done" ? "task_done" : "task_cancelled");
      continue;
    }

    if (task.status === "in_progress") {
      const notes = (await client.getTaskNotes(s.taskId)) as Array<{ id?: string; action?: string; detail?: string }>;
      if (s.failureAttemptId) {
        const failedIndex = notes.findIndex((note) => note.action === "failed" && failureActionAttemptId(note.detail) === s.failureAttemptId);
        if (failedIndex >= 0 && notes.slice(failedIndex + 1).some((note) => note.action === "retried")) {
          await resumeOne(s, ERROR_RETRY_PROMPT);
          continue;
        }
      }
      const latestReviewIndex = notes.map((note) => note.action).lastIndexOf("review_requested");
      const rejectLog =
        latestReviewIndex >= 0
          ? [...notes.slice(latestReviewIndex + 1)].reverse().find((note) => note.action === "rejected" && note.id !== s.lastRejectionActionId)
          : undefined;
      if (rejectLog) {
        const reason = rejectLog.detail || "No reason provided";
        const message = `Task rejected. Reason: ${reason}\n\nThe task is already assigned to this session and is already in_progress. Do not run ak task claim again. Continue directly in the preserved workspace, fix the issues, and submit the task for review again.`;
        const pendingRejectionActionId = rejectLog.id;
        if (pendingRejectionActionId) await sessions.patch(s.sessionId, { pendingRejectionActionId });
        await resumeOne({ ...s, pendingRejectionActionId }, message);
      } else {
        const failure = {
          category: "protocol",
          code: "TASK_NOT_SUBMITTED",
          message: "Agent returned a result without moving the task to review",
          retryable: true,
        } as const;
        const failureAttemptId = randomUUID();
        await sessions.patch(s.sessionId, { failureAttemptId, lastFailure: failure });
        await client.failTask(s.taskId, { ...failure, session_id: s.sessionId, runtime: s.runtime, attempt_id: failureAttemptId });
        await sessions.applyEvent(s.sessionId, { type: "iterator_failed" }, { lastFailure: failure, failureAttemptId, errorAt: Date.now() });
        logger.warn(`Moved task ${s.taskId} to error queue and preserved its review workspace`);
      }
    } else if (task.status === "error") {
      const notes = (await client.getTaskNotes(s.taskId)) as Array<{ action?: string; detail?: string | null }>;
      const latestFailed = [...notes].reverse().find((note) => note.action === "failed" && failureActionAttemptId(note.detail));
      const failureAttemptId = failureActionAttemptId(latestFailed?.detail) ?? s.failureAttemptId;
      const failure =
        s.lastFailure ??
        ({
          category: "unknown",
          code: "RECOVERED_ERROR_STATE",
          message: "Recovered server-side error state after daemon restart",
          retryable: true,
        } as const);
      await sessions.applyEvent(s.sessionId, { type: "iterator_failed" }, { lastFailure: failure, failureAttemptId, errorAt: Date.now() });
      logger.warn(`Recovered review session for task ${s.taskId} in error; preserving workspace`);
    }
  }
}

/** Resume only after a user/lead explicitly moves an error task back to in_progress. */
export async function checkErroredSessions(
  sessions: SessionManager,
  pool: RuntimePool,
  client: ApiClient,
  resumeOne: ResumeCallback,
  maxConcurrent: number,
): Promise<void> {
  for (const s of sessions.list({ type: "worker", status: "errored" })) {
    if (!s.taskId || pool.hasTask(s.taskId)) continue;
    const task = (await apiCallOptional("getTask", () => client.getTask(s.taskId!))) as { status?: string } | null;
    if (!task) {
      await completeTerminalFromError(sessions, s, { type: "task_deleted" }, "task_deleted");
    } else if (task.status === "done" || task.status === "cancelled") {
      await completeTerminalFromError(sessions, s, { type: "task_cancelled" }, task.status === "done" ? "task_done" : "task_cancelled");
    } else if (task.status === "todo" || task.status === "in_progress") {
      if (task.status === "in_progress" && pool.activeCountForRuntime(s.runtime) < maxConcurrent) {
        const notes = (await client.getTaskNotes(s.taskId)) as Array<{ action?: string; detail?: string | null }>;
        const failedIndex = notes.findIndex((note) => note.action === "failed" && failureActionAttemptId(note.detail) === s.failureAttemptId);
        const explicitlyRetried = failedIndex >= 0 && notes.slice(failedIndex + 1).some((note) => note.action === "retried");
        if (explicitlyRetried) {
          await resumeOne(s, ERROR_RETRY_PROMPT);
          continue;
        }
      }
      const failure = s.lastFailure ?? {
        category: "unknown",
        code: "FAILURE_PERSISTENCE_RETRY",
        message: "Runtime failed before the control plane recorded the error",
        retryable: true,
      };
      const failureAttemptId = s.failureAttemptId ?? randomUUID();
      if (!s.failureAttemptId) await sessions.patch(s.sessionId, { failureAttemptId });
      await client.failTask(s.taskId, { ...failure, session_id: s.sessionId, runtime: s.runtime, attempt_id: failureAttemptId });
      logger.warn(`Reconciled missing error state for task ${s.taskId}; workspace remains preserved`);
    }
  }
}

function failureActionAttemptId(detail: string | null | undefined): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as { attempt_id?: unknown };
    return typeof parsed.attempt_id === "string" ? parsed.attempt_id : null;
  } catch {
    return null;
  }
}

async function completeTerminalFromError(
  sessions: SessionManager,
  s: SessionFile,
  event: { type: "task_cancelled" | "task_deleted" },
  reason: WorkspaceCleanupReason,
): Promise<void> {
  await sessions.applyEvent(s.sessionId, event);
  if (s.workspace) cleanupWorkspace(s.workspace, reason);
  await sessions.applyEvent(s.sessionId, { type: "cleanup_done" });
}

/** Drive an in_review session through the state machine to terminal. */
async function completeTerminalFromReview(
  sessions: SessionManager,
  s: SessionFile,
  event: { type: "task_cancelled" | "task_deleted" },
  reason: WorkspaceCleanupReason,
): Promise<void> {
  await sessions.applyEvent(s.sessionId, event).catch((e) => {
    logger.warn(`Review session event failed for ${s.sessionId}: ${errMessage(e)}`);
  });
  if (s.workspace) cleanupWorkspace(s.workspace, reason);
  await sessions.applyEvent(s.sessionId, { type: "cleanup_done" }).catch((e) => {
    logger.warn(`Review session cleanup failed for ${s.sessionId}: ${errMessage(e)}`);
  });
}

// ---- Helpers ----

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
