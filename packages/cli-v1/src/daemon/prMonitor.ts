import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiClient } from "../client/index.js";
import { createLogger } from "../logger.js";
import { TRACKED_TASKS_FILE } from "../paths.js";
import { getSessionManager } from "../session/manager.js";

const logger = createLogger("pr-monitor");

// PR Monitor: watches in_review tasks spawned by this machine.
//   PR merged  → task done
//   PR closed  → task cancelled

const PR_CHECK_INTERVAL = 30_000; // 30s

export class PrMonitor {
  private client: ApiClient;
  private trackedTasks: Set<string>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private failureCount = 0;
  private taskFailures = new Map<string, number>();

  constructor(client: ApiClient) {
    this.client = client;
    this.trackedTasks = loadTrackedTasks();
  }

  start(): void {
    // Seed tracked tasks from any worker session still on disk. This closes
    // the "in_progress blind spot" — if a PR state change happens before the
    // scheduler tracks the task (e.g. agent opened a draft PR while still in
    // in_progress), we still observe it.
    const sm = getSessionManager();
    for (const s of sm.list({ type: "worker" })) {
      if (s.taskId && s.status !== "closed" && s.status !== "completing") {
        this.trackedTasks.add(s.taskId);
      }
    }
    saveTrackedTasks(this.trackedTasks);
    this.timer = setInterval(() => this.check(), PR_CHECK_INTERVAL);
    logger.info(`PR monitor started (tracking=${this.trackedTasks.size}, interval=30s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  track(taskId: string): void {
    this.trackedTasks.add(taskId);
    saveTrackedTasks(this.trackedTasks);
  }

  untrack(taskId: string): void {
    this.trackedTasks.delete(taskId);
    this.taskFailures.delete(taskId);
    saveTrackedTasks(this.trackedTasks);
  }

  private async check(): Promise<void> {
    if (this.checking || this.trackedTasks.size === 0) return;
    this.checking = true;

    try {
      for (const taskId of [...this.trackedTasks]) {
        let task: { status: string; pr_url?: string } | null;
        try {
          task = (await this.client.getTask(taskId)) as { status: string; pr_url?: string } | null;
        } catch {
          this.untrack(taskId);
          continue;
        }

        if (!task || task.status === "done" || task.status === "cancelled") {
          logger.info(`Task ${taskId} is ${task?.status ?? "unknown"}, untracking`);
          this.untrack(taskId);
          continue;
        }

        if (!task.pr_url) continue;

        const state = getPrState(task.pr_url);
        if (!state) {
          const count = (this.taskFailures.get(taskId) ?? 0) + 1;
          this.taskFailures.set(taskId, count);
          if (count === 20) {
            logger.warn(`Cannot check PR status for task ${taskId} (${task.pr_url}), gh may need re-auth`);
          }
          continue;
        }

        this.taskFailures.delete(taskId);

        if (state === "MERGED") {
          logger.info(`PR merged for task ${taskId}, marking done`);
          await this.client.completeTask(taskId);
          this.untrack(taskId);
        } else if (state === "CLOSED") {
          logger.info(`PR closed for task ${taskId}, marking cancelled`);
          await this.client.cancelTask(taskId);
          this.untrack(taskId);
        }
      }

      this.failureCount = 0;
    } catch (err: any) {
      this.failureCount++;
      if (this.failureCount === 10 || (this.failureCount > 10 && this.failureCount % 10 === 0)) {
        logger.error(`PR monitor has failed ${this.failureCount} consecutive checks: ${err.message}. Check gh auth status.`);
      } else if (this.failureCount < 10) {
        logger.warn(`PR monitor error: ${err.message}`);
      }
    } finally {
      this.checking = false;
    }
  }
}

function getPrState(prUrl: string): "OPEN" | "MERGED" | "CLOSED" | null {
  try {
    const raw = execSync(`gh pr view "${prUrl}" --json state -q .state`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    if (raw === "OPEN" || raw === "MERGED" || raw === "CLOSED") return raw;
    return null;
  } catch {
    return null;
  }
}

function loadTrackedTasks(): Set<string> {
  try {
    const data = JSON.parse(readFileSync(TRACKED_TASKS_FILE, "utf-8"));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveTrackedTasks(tasks: Set<string>): void {
  mkdirSync(dirname(TRACKED_TASKS_FILE), { recursive: true });
  writeFileSync(TRACKED_TASKS_FILE, `${JSON.stringify([...tasks])}\n`);
}
