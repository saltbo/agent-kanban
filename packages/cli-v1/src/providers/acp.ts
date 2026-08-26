/**
 * Generic provider for ACP (Agent Client Protocol) agents.
 *
 * `createAcpProvider(config)` spawns the configured binary with stdio wired
 * into an ACP `ClientSideConnection` and returns an `AgentProvider` that
 * speaks the protocol. All ACP-compliant agents share this single
 * implementation — registering a new runtime is a one-row config entry in
 * registry.ts.
 *
 * Session lifecycle:
 *   execute() → initialize → newSession|loadSession → prompt (background)
 *   → stream session_update notifications as AgentEvents → prompt resolves
 *   → emit turn.end → events iterator ends.
 *
 * See https://agentclientprotocol.com
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { ToolName } from "@agent-kanban/shared";
import type {
  Client,
  ClientSideConnection,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { createLogger } from "../logger.js";

async function sdk() {
  try {
    return await import("@agentclientprotocol/sdk");
  } catch {
    throw new Error("@agentclientprotocol/sdk is not installed; provider features need it on this host");
  }
}

import type { AgentEvent, AgentHandle, AgentProvider, AgentRuntime, ContentBlock, ExecuteOpts, HistoryEvent } from "./types.js";

export interface AcpRuntimeConfig {
  runtime: AgentRuntime;
  label: string;
  command: string;
  args: string[];
}

export function createAcpProvider(config: AcpRuntimeConfig): AgentProvider {
  return {
    name: config.runtime,
    label: config.label,
    execute: (opts) => acpExecute(config, opts),
    getHistory: (_sessionId, resumeToken) => acpGetHistory(config, resumeToken),
  };
}

// ---- Execution ----

interface RuntimeState {
  aborted: boolean;
}

async function acpExecute(config: AcpRuntimeConfig, opts: ExecuteOpts): Promise<AgentHandle> {
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await sdk();
  const logger = createLogger(`acp:${config.runtime}`);
  const proc = spawn(config.command, config.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachStderrLogger(proc, logger);

  const queue = new EventQueue();
  const mapState: MapState = { turnOpen: false, pendingTools: new Map() };
  const runtimeState: RuntimeState = { aborted: false };
  const client = buildClient(queue, mapState);

  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const conn = new ClientSideConnection(() => client, ndJsonStream(input, output));

  await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });

  const sessionId = await openSession(conn, opts);
  const systemPrompt = opts.systemPromptFile ? readFileSync(opts.systemPromptFile, "utf-8") : undefined;
  const promptDone = runPromptLoop(conn, sessionId, opts.taskContext, systemPrompt, queue, mapState, runtimeState, logger);

  proc.once("exit", (code) => {
    if (!runtimeState.aborted && code !== 0 && !queue.done) {
      queue.finish(new Error(`${config.runtime} exited with code ${code}`));
    }
  });

  return {
    events: queue.iterate(),
    async abort() {
      if (runtimeState.aborted) return;
      runtimeState.aborted = true;
      await conn.cancel({ sessionId }).catch(() => {});
      await promptDone.catch(() => {});
      queue.finish();
      await terminateProcess(proc);
    },
    async send() {
      throw new Error(`${config.runtime}: multi-turn send not implemented`);
    },
    getResumeToken() {
      // After abort the session is in an indeterminate state on the agent side — don't advertise it.
      return runtimeState.aborted ? undefined : sessionId;
    },
  };
}

async function openSession(conn: ClientSideConnection, opts: ExecuteOpts): Promise<string> {
  if (opts.resume) {
    if (!opts.resumeToken) throw new Error("acp: resume requested but no resumeToken provided");
    await conn.loadSession({ sessionId: opts.resumeToken, cwd: opts.cwd, mcpServers: [] });
    return opts.resumeToken;
  }
  const result = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
  return result.sessionId;
}

/**
 * Drive `session/prompt` to completion and translate the terminal state
 * into an `AgentEvent` on the queue. `mapState.turnOpen` is reset here
 * (not in `mapSessionUpdate`) because the turn boundary is the prompt
 * response, not any particular session update.
 */
async function runPromptLoop(
  conn: ClientSideConnection,
  sessionId: string,
  taskContext: string,
  systemPrompt: string | undefined,
  queue: EventQueue,
  mapState: MapState,
  runtime: RuntimeState,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  // ACP has no dedicated system-message channel; combine the daemon's agent
  // work protocol with the task context so the agent gets claim/review
  // lifecycle instructions before the task description.
  const prompt = systemPrompt
    ? [
        { type: "text" as const, text: systemPrompt },
        { type: "text" as const, text: taskContext },
      ]
    : [{ type: "text" as const, text: taskContext }];
  try {
    const resp: PromptResponse = await conn.prompt({
      sessionId,
      prompt,
    });
    // If abort() has already taken the wheel, let it drive finalization.
    if (runtime.aborted) return;
    queue.push(buildTurnEnd(resp));
    queue.finish();
  } catch (err) {
    if (runtime.aborted) return;
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`prompt failed: ${detail}`);
    queue.push({ type: "turn.error", detail });
    queue.finish();
  } finally {
    mapState.turnOpen = false;
  }
}

/** @internal Exported for tests only. */
export function buildTurnEnd(resp: PromptResponse): AgentEvent {
  const usage = resp.usage;
  return {
    type: "turn.end",
    cost: 0,
    usage: usage
      ? {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_read_input_tokens: usage.cachedReadTokens ?? 0,
          cache_creation_input_tokens: usage.cachedWriteTokens ?? 0,
        }
      : undefined,
  };
}

// ---- History (session/load streams past updates back as notifications) ----

/**
 * Collect history for an ACP session by driving `session/load`, which the
 * spec requires the agent to fulfil by replaying every past `session/update`
 * notification before the request resolves. We use a throwaway subprocess
 * so the live runtime isn't perturbed.
 */
async function acpGetHistory(config: AcpRuntimeConfig, resumeToken: string | undefined): Promise<HistoryEvent[]> {
  if (!resumeToken) return [];
  const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await sdk();
  const logger = createLogger(`acp:${config.runtime}:history`);
  const proc = spawn(config.command, config.args, {
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachStderrLogger(proc, logger);

  const history: HistoryEvent[] = [];
  const mapState: MapState = { turnOpen: false, pendingTools: new Map() };
  let counter = 0;

  const client: Client = {
    ...readOnlyClient(),
    async sessionUpdate(params: SessionNotification): Promise<void> {
      for (const event of mapSessionUpdate(params.update, mapState)) {
        history.push({ id: `${config.runtime}-hist-${++counter}`, event, timestamp: new Date().toISOString() });
      }
    },
    // History replay must not provoke tool execution; cancel any permission request.
    async requestPermission(): Promise<RequestPermissionResponse> {
      return { outcome: { outcome: "cancelled" } };
    },
  };

  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const conn = new ClientSideConnection(() => client, ndJsonStream(input, output));

  try {
    await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    await conn.loadSession({ sessionId: resumeToken, cwd: process.cwd(), mcpServers: [] });
  } catch (err) {
    logger.warn(`loadSession failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await terminateProcess(proc);
  }
  return history;
}

// ---- Client (ACP → AgentEvent) ----

/**
 * Client handlers for capabilities we don't opt into: filesystem + terminal.
 * All throw so an agent that tries them (contra our capability advertisement)
 * surfaces a protocol error instead of silently corrupting state.
 */
function readOnlyClient(): Omit<Client, "sessionUpdate" | "requestPermission"> {
  return {
    async writeTextFile() {
      throw new Error("fs.write_text_file not supported (agent should use its own tools)");
    },
    async readTextFile() {
      throw new Error("fs.read_text_file not supported (agent should use its own tools)");
    },
    async createTerminal() {
      throw new Error("terminal.create not supported");
    },
    async killTerminal() {
      throw new Error("terminal.kill not supported");
    },
    async terminalOutput() {
      throw new Error("terminal.output not supported");
    },
    async waitForTerminalExit() {
      throw new Error("terminal.wait_for_exit not supported");
    },
    async releaseTerminal() {
      throw new Error("terminal.release not supported");
    },
  };
}

function buildClient(queue: EventQueue, state: MapState): Client {
  return {
    ...readOnlyClient(),
    async sessionUpdate(params: SessionNotification): Promise<void> {
      for (const event of mapSessionUpdate(params.update, state)) queue.push(event);
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return { outcome: autoApprove(params) };
    },
  };
}

/** @internal Exported for tests only. */
export function autoApprove(params: RequestPermissionRequest): RequestPermissionResponse["outcome"] {
  const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options.find((o) => o.kind === "allow_always");
  if (allow) return { outcome: "selected", optionId: allow.optionId };
  // Agent offered no allow variant — there is no human in the loop to decide,
  // so report the request as cancelled and let the agent handle the denial.
  return { outcome: "cancelled" };
}

// ---- Event mapping ----

export interface MapState {
  turnOpen: boolean;
  pendingTools: Map<string, ContentBlock & { type: "tool_use" }>;
}

/** Map one ACP `SessionUpdate` to zero or more `AgentEvent`s. Pure; exported for tests. */
export function* mapSessionUpdate(update: SessionUpdate, state: MapState): Generator<AgentEvent> {
  if (!state.turnOpen) {
    state.turnOpen = true;
    yield { type: "turn.start" };
  }
  yield* mapUpdateBody(update, state);
}

function* mapUpdateBody(update: SessionUpdate, state: MapState): Generator<AgentEvent> {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      yield* emitTextChunk(update.content, "text");
      return;
    case "agent_thought_chunk":
      yield* emitTextChunk(update.content, "thinking");
      return;
    case "tool_call": {
      const block: ContentBlock & { type: "tool_use" } = {
        type: "tool_use",
        id: update.toolCallId,
        name: mapToolName(update.kind, update.title),
        input: (update.rawInput ?? {}) as Record<string, unknown>,
      };
      state.pendingTools.set(update.toolCallId, block);
      yield { type: "block.start", block };
      return;
    }
    case "tool_call_update": {
      const status = update.status;
      if (status !== "completed" && status !== "failed") return;
      const block = state.pendingTools.get(update.toolCallId);
      // Orphan update (no prior tool_call for this id) — nothing to close against,
      // so emitting a lone tool_result would confuse the consumer. Drop silently.
      if (!block) return;
      state.pendingTools.delete(update.toolCallId);
      yield { type: "block.done", block };
      yield {
        type: "block.done",
        block: {
          type: "tool_result",
          tool_use_id: update.toolCallId,
          output: flattenToolOutput(update.content ?? undefined, update.rawOutput),
          error: status === "failed" ? true : undefined,
        },
      };
      return;
    }
    default:
      return;
  }
}

function* emitTextChunk(content: { type: string; text?: string }, kind: "text" | "thinking"): Generator<AgentEvent> {
  if (content.type !== "text" || !content.text) return;
  yield { type: "block.start", block: { type: kind, text: "" } };
  yield { type: "block.done", block: { type: kind, text: content.text } };
}

const TOOL_KIND_TO_NAME: Partial<Record<ToolKind, string>> = {
  read: ToolName.Read,
  edit: ToolName.Edit,
  search: ToolName.Grep,
  execute: ToolName.Bash,
  fetch: ToolName.WebFetch,
};

/** @internal Exported for tests only. */
export function mapToolName(kind: ToolKind | undefined, title: string): string {
  if (kind && TOOL_KIND_TO_NAME[kind]) return TOOL_KIND_TO_NAME[kind]!;
  return title || "tool";
}

function flattenToolOutput(content: ToolCallContent[] | undefined, rawOutput: unknown): string {
  if (content?.length) {
    const texts = content.map((c) => (c.type === "content" && c.content.type === "text" ? c.content.text : "")).filter(Boolean);
    if (texts.length) return texts.join("\n");
  }
  if (typeof rawOutput === "string") return rawOutput;
  if (rawOutput != null) return JSON.stringify(rawOutput);
  return "";
}

// ---- Event queue (ACP handlers push here; iterator pulls) ----

/** @internal Exported for tests only. */
export class EventQueue {
  private buffer: AgentEvent[] = [];
  private waiter: (() => void) | null = null;
  private error: unknown = null;
  done = false;

  push(event: AgentEvent): void {
    if (this.done) return;
    this.buffer.push(event);
    this.waiter?.();
  }

  finish(err?: unknown): void {
    if (this.done) return;
    this.done = true;
    if (err !== undefined) this.error = err;
    this.waiter?.();
  }

  async *iterate(): AsyncIterable<AgentEvent> {
    while (true) {
      while (this.buffer.length) yield this.buffer.shift()!;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
    while (this.buffer.length) yield this.buffer.shift()!;
    if (this.error) throw this.error;
  }
}

// ---- Process helpers ----

function attachStderrLogger(proc: ChildProcess, logger: ReturnType<typeof createLogger>): void {
  proc.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) logger.debug(text);
  });
}

function terminateProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid || proc.killed) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
      resolve();
    }, 5000);
    proc.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}
