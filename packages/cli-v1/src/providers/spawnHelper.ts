import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent, AgentHandle } from "./types.js";

export interface SpawnAgentOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  onLine?: (raw: string) => void;
  parseEvent: (raw: string) => AgentEvent | null;
}

/**
 * Spawn a process-backed agent. Returns a uniform AgentHandle whose
 * internals encapsulate all process management:
 *   - SIGTERM → 5s grace → SIGKILL escalation
 *   - abort() is idempotent; a second call is a no-op
 *   - when abort() has been called, a subsequent SIGTERM-induced exit is
 *     NOT thrown as a crash — the iterator ends cleanly
 *   - stderr is buffered (bounded) and attached to any thrown exit error
 *
 * No `pid` is exposed on the handle — the daemon layer doesn't know or care
 * that there is a child process underneath.
 */
export function spawnAgent(opts: SpawnAgentOpts): AgentHandle {
  const state: SpawnState = { aborted: false };

  const proc = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env,
  });

  if (opts.input && proc.stdin) {
    proc.stdin.write(`${opts.input}\n`);
    // Keep stdin open for send()
  }

  let stderrBuffer = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    if (stderrBuffer.length > 50000) stderrBuffer = stderrBuffer.slice(-25000);
  });

  const events = createEventStream(proc, opts.parseEvent, () => stderrBuffer, state, opts.onLine);

  return {
    events,
    abort: () => terminateProcess(proc, state),
    send: async (message: string) => {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.write(`${message}\n`);
      }
    },
  };
}

interface SpawnState {
  aborted: boolean;
}

async function* createEventStream(
  proc: ChildProcess,
  parseEvent: (raw: string) => AgentEvent | null,
  getStderr: () => string,
  state: SpawnState,
  onLine?: (raw: string) => void,
): AsyncGenerator<AgentEvent> {
  let buffer = "";
  const queue: AgentEvent[] = [];
  let done = false;
  let exitCode: number | null = null;
  let exitError: Error | null = null;
  let resolve: (() => void) | null = null;

  const signal = () => resolve?.();

  proc.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      onLine?.(line);
      const event = parseEvent(line);
      if (event) {
        queue.push(event);
        signal();
      }
    }
  });

  proc.on("close", (code) => {
    if (buffer.trim()) {
      onLine?.(buffer);
      const event = parseEvent(buffer);
      if (event) queue.push(event);
    }
    exitCode = code;
    done = true;
    signal();
  });

  proc.on("error", (err) => {
    exitError = err;
    done = true;
    signal();
  });

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!;
    }
    if (done) break;
    await new Promise<void>((r) => {
      resolve = r;
    });
    resolve = null;
  }

  // Aborted: swallow any exit code / error. The iterator ends cleanly so the
  // daemon treats it as a normal termination rather than a crash.
  if (state.aborted) return;

  if (exitError) throw exitError;

  if (exitCode !== null && exitCode !== 0) {
    const stderr = getStderr().trim().split("\n").slice(-10).join("\n");
    const err = new Error(`Process exited with code ${exitCode}`);
    (err as { exitCode?: number }).exitCode = exitCode;
    (err as { stderr?: string }).stderr = stderr;
    throw err;
  }
}

function terminateProcess(proc: ChildProcess, state: SpawnState): Promise<void> {
  return new Promise((resolve) => {
    if (state.aborted) {
      resolve();
      return;
    }
    state.aborted = true;

    if (!proc.pid || proc.killed) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(killTimer);
      resolve();
    };
    proc.once("close", onExit);
    proc.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      proc.removeListener("close", onExit);
      if (!proc.killed) proc.kill("SIGKILL");
      resolve();
    }, 5000);
  });
}
