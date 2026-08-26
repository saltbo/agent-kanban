import { collectUsage as collectLeaderUsage } from "../agent/usage.js";
import type { MachineClient } from "../client/index.js";
import { createLogger } from "../logger.js";
import { isPidAlive, listSessions, removeSession } from "../session/store.js";

const logger = createLogger("daemon");

export async function cleanupLeaderSessions(client: MachineClient): Promise<void> {
  for (const session of listSessions({ type: "leader" })) {
    if (isPidAlive(session.pid)) continue;
    const usage = await collectLeaderUsage(session.runtime, session.startedAt);
    if (usage) {
      await client.updateSessionUsage(session.agentId, session.sessionId, usage).catch((err: any) => {
        logger.warn(`Leader usage report failed for ${session.sessionId.slice(0, 8)}: ${err.message}`);
      });
    }
    await client.closeSession(session.agentId, session.sessionId).catch((err: any) => {
      logger.warn(`Leader session close failed for ${session.sessionId.slice(0, 8)}: ${err.message}`);
    });
    removeSession(session.sessionId);
    logger.info(`Cleaned up leader session ${session.sessionId.slice(0, 8)} (${session.runtime}, PID ${session.pid})`);
  }
}

/**
 * Startup-time stale session cleanup. Runs on daemon boot, before any
 * ProcessManager exists. At this point, ANY worker session on disk is
 * orphaned from a previous daemon incarnation — the old daemon is gone,
 * the in-memory AgentRuntimePool is empty, so there's no live handle for
 * any of them.
 *
 * Exception: sessions in `in_review` must survive every restart. They're
 * the reject-resume entry point.
 *
 * For leader sessions we still use pid liveness, because leaders are
 * anchored to a long-lived external runtime (e.g. GH Actions step) whose
 * lifetime is independent of the daemon.
 */
export async function cleanupStaleSessions(client: MachineClient, machineId: string): Promise<void> {
  try {
    const agents = (await client.listAgents()) as any[];
    let closedCount = 0;
    for (const agent of agents) {
      const sessions = (await client.listSessions(agent.id)) as any[];
      for (const session of sessions) {
        if (session.status !== "active" || session.machine_id !== machineId) continue;
        const local = listSessions().find((s) => s.sessionId === session.id);

        // Worker sessions: in_review survives forever; everything else is
        // orphaned at boot time (no live handle can exist yet).
        // Leader sessions: pid liveness.
        if (local?.type === "worker") {
          // in_review survives restarts (reject-resume entry point).
          // closed sessions are intentionally retained for history lookup — skip.
          if (local.status === "in_review" || local.status === "closed") continue;
        } else if (local?.type === "leader") {
          if (isPidAlive(local.pid)) continue;
        }

        if (local?.type === "worker" && local.taskId) {
          await client.releaseTask(local.taskId).catch((err: any) => {
            logger.warn(`Failed to release stale task ${local.taskId}: ${err.message}`);
          });
        }
        await client.closeSession(agent.id, session.id).catch(() => {});
        if (local) {
          logger.info(`Closing stale session ${session.id.slice(0, 8)} for agent ${agent.id.slice(0, 8)}`);
          removeSession(local.sessionId);
        }
        closedCount++;
      }
    }
    if (closedCount > 0) logger.info(`Cleaned up ${closedCount} stale session(s) from previous run`);
  } catch (err: any) {
    logger.warn(`Session cleanup failed: ${err.message}`);
  }
}

// Startup health check — cross-reference local worker sessions against server
// task state and log any divergence loudly. Catches the "silent orphan" class
// of bugs where a reject-resume entry point (in_review session file) was lost
// for any reason: previous daemon crash, manual cleanup, bugs in shutdown/
// cleanup code paths, disk corruption, etc.
//
// Non-destructive by design: only logs. Recovery is left to the operator because
// the right action depends on context (release vs cancel vs manual merge).
export async function auditOrphanedTasks(client: MachineClient, _machineId: string): Promise<void> {
  try {
    const workers = listSessions({ type: "worker" }).filter((s) => s.status !== "closed");
    let resumeQueued = 0;
    let diverged = 0;

    for (const s of workers) {
      if (!s.taskId) continue;
      let task: any;
      try {
        task = await client.getTask(s.taskId);
      } catch (err: any) {
        logger.warn(`Startup audit: failed to fetch task ${s.taskId}: ${err.message}`);
        continue;
      }
      if (!task) {
        logger.warn(`Startup audit: local session ${s.sessionId.slice(0, 8)} references missing task ${s.taskId}`);
        continue;
      }

      if (s.status === "in_review" && task.status === "in_progress") {
        logger.info(`Startup audit: task ${s.taskId} was rejected while daemon was down — will resume on next tick`);
        resumeQueued++;
      } else if (s.status === "in_review" && task.status !== "in_review") {
        logger.warn(
          `Startup audit: local session ${s.sessionId.slice(0, 8)} is in_review but server task ${s.taskId} is ${task.status} — session is stale`,
        );
        diverged++;
      }
    }

    if (resumeQueued > 0 || diverged > 0) {
      logger.info(`Startup audit: ${resumeQueued} task(s) queued for resume, ${diverged} session(s) diverged`);
    }
  } catch (err: any) {
    logger.warn(`Startup audit failed: ${err.message}`);
  }
}
