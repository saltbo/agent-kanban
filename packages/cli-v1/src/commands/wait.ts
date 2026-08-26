import { spawn } from "node:child_process";
import type { Task, TaskStatus } from "@agent-kanban/shared";
import type { Command } from "commander";
import { createClient } from "../agent/leader.js";

const POLL_INTERVAL_MS = 5000;
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "cancelled"]);
const FILTERABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["todo", "in_progress", "in_review", "done", "cancelled"]);

// Exit codes — see CLAUDE.md / wait design
const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_UNREACHABLE = 2;
const EXIT_TIMEOUT = 124;

/**
 * Parse a duration string like "30s", "15m", "2h". "0" means infinite.
 * Returns milliseconds, or Infinity for "0".
 */
export function parseDuration(input: string): number {
  if (input === "0") return Number.POSITIVE_INFINITY;
  const m = /^(\d+)(ms|s|m|h)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input} (expected e.g. 30s, 15m, 2h, or 0 for infinite)`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
  }
  throw new Error(`Invalid duration unit: ${m[2]}`);
}

function parseStatusList(input: string): TaskStatus[] {
  const parts = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    if (!FILTERABLE_STATUSES.has(p as TaskStatus)) {
      throw new Error(`Invalid status: ${p} (expected one of ${[...FILTERABLE_STATUSES].join(",")})`);
    }
  }
  return parts as TaskStatus[];
}

function shortTitle(t: Pick<Task, "title">): string {
  return t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title;
}

function printEvent(status: TaskStatus, task: Pick<Task, "id" | "title" | "pr_url">): void {
  const pr = task.pr_url ? `  PR=${task.pr_url}` : "";
  process.stdout.write(`[${status}]  ${task.id}  ${shortTitle(task)}${pr}\n`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Generic poll loop. `tick` returns:
 *   - "done"     → exit 0
 *   - "unreachable" → exit 2
 *   - undefined  → keep polling
 */
async function pollUntil(deadline: number, tick: () => Promise<"done" | "unreachable" | undefined>): Promise<number> {
  while (true) {
    const result = await tick();
    if (result === "done") return EXIT_OK;
    if (result === "unreachable") return EXIT_UNREACHABLE;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return EXIT_TIMEOUT;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

// ─── ak wait task ───

interface TaskWaitOpts {
  until: TaskStatus;
  timeout: number;
}

export async function waitForTasks(ids: string[], opts: TaskWaitOpts): Promise<number> {
  const client = await createClient();
  const lastStatus = new Map<string, TaskStatus>();
  const deadline = Date.now() + opts.timeout;

  return pollUntil(deadline, async () => {
    let allReached = true;
    for (const id of ids) {
      const task = (await client.getTask(id)) as Task;
      const prev = lastStatus.get(id);
      if (prev !== task.status) {
        printEvent(task.status, task);
        lastStatus.set(id, task.status);
      }
      if (task.status !== opts.until) {
        // cancelled is unreachable unless that's what we're waiting for
        if (task.status === "cancelled" && opts.until !== "cancelled") {
          process.stderr.write(`task ${id} was cancelled — target ${opts.until} unreachable\n`);
          return "unreachable";
        }
        allReached = false;
      }
    }
    return allReached ? "done" : undefined;
  });
}

// ─── ak wait board ───

export interface BoardWaitOpts {
  until?: string; // <status> | all-done | all-<status> | first-match
  filter?: TaskStatus[];
  label?: string;
  includeCurrent: boolean;
  timeout: number;
}

type SnapshotPredicate = (tasks: Task[]) => boolean;

function compilePredicate(until: string): SnapshotPredicate {
  if (until === "all-done") {
    return (ts) => ts.length > 0 && ts.every((t) => TERMINAL_STATUSES.has(t.status));
  }
  if (until.startsWith("all-")) {
    const status = until.slice(4) as TaskStatus;
    if (!FILTERABLE_STATUSES.has(status)) throw new Error(`Invalid --until value: ${until}`);
    return (ts) => ts.length > 0 && ts.every((t) => t.status === status);
  }
  if (FILTERABLE_STATUSES.has(until as TaskStatus)) {
    const status = until as TaskStatus;
    return (ts) => ts.some((t) => t.status === status);
  }
  throw new Error(`Invalid --until value: ${until}`);
}

/**
 * Emit board events for one poll snapshot. Returns true if any task matched the filter mask this tick.
 */
function emitBoardEvents(
  tasks: Task[],
  lastStatus: Map<string, TaskStatus>,
  filterSet: Set<TaskStatus> | null,
  firstTick: boolean,
  includeCurrent: boolean,
): boolean {
  let matchedThisTick = false;
  for (const task of tasks) {
    const prev = lastStatus.get(task.id);
    const isInitial = prev === undefined;
    const isTransition = !isInitial && prev !== task.status;
    lastStatus.set(task.id, task.status);

    const matchesFilter = !filterSet || filterSet.has(task.status);
    const shouldEmit = isTransition || (isInitial && (!firstTick || includeCurrent));
    if (shouldEmit && matchesFilter) {
      printEvent(task.status, task);
      matchedThisTick = true;
    }
  }
  return matchedThisTick;
}

export async function waitForBoard(boardId: string, opts: BoardWaitOpts): Promise<number> {
  const client = await createClient();

  const params: Record<string, string> = { board_id: boardId };
  if (opts.label) params.label = opts.label;

  const untilMode = opts.until ?? (opts.filter ? "first-match" : "all-done");
  const isFirstMatch = untilMode === "first-match";
  const predicate: SnapshotPredicate = isFirstMatch ? () => false : compilePredicate(untilMode);
  const filterSet = opts.filter ? new Set(opts.filter) : null;
  const lastStatus = new Map<string, TaskStatus>();
  let firstTick = true;
  const deadline = Date.now() + opts.timeout;

  return pollUntil(deadline, async () => {
    const tasks = (await client.listTasks(params)) as Task[];
    const matchedThisTick = emitBoardEvents(tasks, lastStatus, filterSet, firstTick, opts.includeCurrent);
    firstTick = false;

    if (isFirstMatch) return matchedThisTick ? "done" : undefined;
    return predicate(tasks) ? "done" : undefined;
  });
}

// ─── ak wait pr ───

const PR_CHECK_RETRY_INTERVAL_MS = 10_000;
const PR_CHECK_MAX_RETRIES = 18; // ~3 minutes of retrying before giving up

export async function waitForPr(num: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; attempt <= PR_CHECK_MAX_RETRIES; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return EXIT_TIMEOUT;

    const { code, stderr } = await runGhChecks(num, remaining);

    if (code === 0) return EXIT_OK;
    if (code === EXIT_TIMEOUT) return EXIT_TIMEOUT;

    // "no checks reported" means CI hasn't created check runs yet — retry.
    const noChecks = stderr.includes("no checks reported");
    if (!noChecks) return EXIT_ERROR;

    if (attempt < PR_CHECK_MAX_RETRIES) {
      process.stderr.write(`No checks yet, retrying in ${PR_CHECK_RETRY_INTERVAL_MS / 1000}s...\n`);
      await sleep(Math.min(PR_CHECK_RETRY_INTERVAL_MS, remaining));
    }
  }

  process.stderr.write("Gave up waiting for checks to appear\n");
  return EXIT_ERROR;
}

function runGhChecks(num: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn("gh", ["pr", "checks", num, "--watch", "--fail-fast"], {
      stdio: ["pipe", "inherit", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = Number.isFinite(timeoutMs)
      ? setTimeout(() => {
          child.kill("SIGTERM");
          resolve({ code: EXIT_TIMEOUT, stderr: "" });
        }, timeoutMs)
      : null;
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      if (err.code === "ENOENT") {
        process.stderr.write("gh is not installed or not in PATH\n");
      } else {
        process.stderr.write(`failed to spawn gh: ${err.message}\n`);
      }
      resolve({ code: EXIT_ERROR, stderr: "" });
    });
    child.on("exit", (exitCode) => {
      if (timer) clearTimeout(timer);
      resolve({ code: exitCode === 0 ? EXIT_OK : EXIT_ERROR, stderr: Buffer.concat(chunks).toString() });
    });
  });
}

// ─── command registration ───

export function registerWaitCommand(program: Command): void {
  const wait = program.command("wait").description("Block until a condition is met");

  wait
    .command("task <ids...>")
    .description("Wait for one or more tasks to reach a target status")
    .option("--until <state>", "Target status (todo|in_progress|in_review|done|cancelled)", "done")
    .option("--timeout <duration>", "Max wait time (e.g. 30s, 15m, 2h, 0=infinite)", "2h")
    .action(async (ids: string[], opts) => {
      try {
        const until = opts.until as TaskStatus;
        if (!FILTERABLE_STATUSES.has(until)) throw new Error(`Invalid --until value: ${until}`);
        const code = await waitForTasks(ids, { until, timeout: parseDuration(opts.timeout) });
        process.exit(code);
      } catch (err: any) {
        process.stderr.write(`${err.message}\n`);
        process.exit(EXIT_ERROR);
      }
    });

  wait
    .command("board <id>")
    .description("Wait for task state changes on a board")
    .option("--until <pred>", "Terminal predicate: <status> | all-done | all-<status> | first-match")
    .option("--filter <list>", "Comma-separated statuses to watch (events outside the list are ignored)")
    .option("--label <label>", "Restrict to tasks carrying this label")
    .option("--include-current", "Treat tasks already in a target state as fresh events (default: true when --filter is set)")
    .option("--timeout <duration>", "Max wait time (e.g. 30s, 1h, 0=infinite)", "2h")
    .action(async (id: string, opts) => {
      try {
        const filter = opts.filter ? parseStatusList(opts.filter) : undefined;
        const code = await waitForBoard(id, {
          until: opts.until,
          filter,
          label: opts.label,
          includeCurrent: opts.includeCurrent ?? !!filter,
          timeout: parseDuration(opts.timeout),
        });
        process.exit(code);
      } catch (err: any) {
        process.stderr.write(`${err.message}\n`);
        process.exit(EXIT_ERROR);
      }
    });

  wait
    .command("pr <num>")
    .description("Wait for a GitHub PR's CI checks to reach a terminal state")
    .option("--timeout <duration>", "Max wait time (e.g. 10m, 1h, 0=infinite)", "30m")
    .action(async (num: string, opts) => {
      try {
        const code = await waitForPr(num, parseDuration(opts.timeout));
        process.exit(code);
      } catch (err: any) {
        process.stderr.write(`${err.message}\n`);
        process.exit(EXIT_ERROR);
      }
    });
}
