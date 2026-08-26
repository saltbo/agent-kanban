import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { EditArgs, GlobArgs, GrepArgs, MultiEditArgs, ReadArgs, WriteArgs } from "@agent-kanban/shared";
import { ToolName } from "@agent-kanban/shared";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { createLogger } from "../logger.js";
import type {
  AgentEvent,
  AgentHandle,
  AgentProvider,
  ContentBlock,
  ExecuteOpts,
  HistoryEvent,
  RuntimeModel,
  UsageInfo,
  UsageWindow,
} from "./types.js";
import { availabilityFromUsage, availabilityFromUsageError, parseRetryAfterMs, UsageFetchError } from "./types.js";

const logger = createLogger("copilot");

async function sdk() {
  try {
    return await import("@github/copilot-sdk");
  } catch {
    throw new Error("@github/copilot-sdk is not installed; provider features need it on this host");
  }
}

const COPILOT_USER_API = "https://api.github.com/copilot_internal/user";

function readGhToken(): string | null {
  try {
    return execSync("gh auth token", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Active sessions keyed by resumeToken (= Copilot session ID), for sharing with getHistory(). */
const activeSessions = new Map<string, CopilotSession>();

interface AccumulatedUsage {
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function makeUsage(): AccumulatedUsage {
  return { cost: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

interface MapState {
  turnOpen: boolean;
  usage: AccumulatedUsage;
  /** Pending tool_use blocks keyed by toolCallId, for closing in tool.execution_complete */
  pendingToolUses: Map<string, ContentBlock & { type: "tool_use" }>;
}

/**
 * Normalize Copilot CLI tool names and input fields to the canonical shapes
 * the frontend expects (matching Claude/Codex tool_use conventions).
 * Copilot CLI uses lowercase snake_case names and different field names;
 * unknown tools pass through for the fallback UI.
 * Returns `{ name: null }` for internal CLI tools that should not be surfaced.
 */
function normalizeCopilotTool(name: string, input: Record<string, unknown>): { name: string | null; input: Record<string, unknown> } {
  switch (name) {
    case "bash":
      return { name: ToolName.Bash, input };
    case "read":
    case "view": {
      const args: ReadArgs = {
        filePath: String(input.path ?? input.file_path ?? ""),
        offset: input.offset as number | undefined,
        limit: input.limit as number | undefined,
      };
      return { name: ToolName.Read, input: args };
    }
    case "write":
    case "create": {
      const args: WriteArgs = { filePath: String(input.path ?? input.file_path ?? ""), content: String(input.file_text ?? input.content ?? "") };
      return { name: ToolName.Write, input: args };
    }
    case "edit": {
      const args: EditArgs = {
        filePath: String(input.path ?? input.file_path ?? ""),
        oldString: String(input.old_str ?? input.old_string ?? ""),
        newString: String(input.new_str ?? input.new_string ?? ""),
        replaceAll: input.replace_all as boolean | undefined,
      };
      return { name: ToolName.Edit, input: args };
    }
    case "multi_edit": {
      const args: MultiEditArgs = {
        filePath: String(input.path ?? input.file_path ?? ""),
        edits: Array.isArray(input.edits)
          ? input.edits.map((e: Record<string, unknown>) => ({
              oldString: String(e.old_str ?? e.old_string ?? ""),
              newString: String(e.new_str ?? e.new_string ?? ""),
              replaceAll: e.replace_all as boolean | undefined,
            }))
          : [],
      };
      return { name: ToolName.MultiEdit, input: args };
    }
    case "glob": {
      const args: GlobArgs = { pattern: String(input.pattern ?? ""), path: input.path as string | undefined };
      return { name: ToolName.Glob, input: args };
    }
    case "grep": {
      const args: GrepArgs = {
        pattern: String(input.pattern ?? ""),
        path: input.path as string | undefined,
        glob: input.glob as string | undefined,
        type: input.type as string | undefined,
        outputMode: input.output_mode as string | undefined,
      };
      return { name: ToolName.Grep, input: args };
    }
    case "web_fetch":
      return { name: ToolName.WebFetch, input };
    case "web_search":
      return { name: ToolName.WebSearch, input };
    case "ask_user":
      return { name: ToolName.AskUserQuestion, input };
    case "task":
      return { name: ToolName.Agent, input };
    case "todo_write":
      return { name: ToolName.TodoWrite, input };
    case "notebook_edit":
      return { name: ToolName.NotebookEdit, input };
    // Internal CLI tools with no frontend equivalent — skip
    case "report_intent":
    case "stop_bash":
    case "read_bash":
    case "write_bash":
    case "list_bash":
      return { name: null, input };
    default:
      return { name, input };
  }
}

/**
 * Map a single Copilot SDK SessionEvent to zero or more AgentEvents.
 * Mutates `state` for turn/usage tracking.
 */
export function* mapCopilotEvent(event: SessionEvent, state: MapState): Generator<AgentEvent> {
  switch (event.type) {
    case "user.message": {
      // The user's prompt sent to the session — surface as message.user
      if (event.data.content) {
        yield { type: "message.user", text: event.data.content };
      }
      return;
    }

    case "assistant.turn_start": {
      if (!state.turnOpen) {
        state.turnOpen = true;
        yield { type: "turn.start" };
      }
      return;
    }

    case "assistant.reasoning": {
      const text = event.data.content;
      if (text) {
        yield { type: "block.start", block: { type: "thinking", text: "" } };
        yield { type: "block.done", block: { type: "thinking", text } };
      }
      return;
    }

    case "assistant.message": {
      const { content, toolRequests, reasoningText } = event.data;

      if (!state.turnOpen) {
        state.turnOpen = true;
        yield { type: "turn.start" };
      }

      if (reasoningText) {
        // block.start with empty text → block.done with full text, matching the streaming
        // contract that RelayRuntimeProvider expects (it fills in text on block.done)
        yield { type: "block.start", block: { type: "thinking", text: "" } };
        yield { type: "block.done", block: { type: "thinking", text: reasoningText } };
      }

      if (content) {
        yield { type: "block.start", block: { type: "text", text: "" } };
        yield { type: "block.done", block: { type: "text", text: content } };
      }

      if (toolRequests) {
        for (const tr of toolRequests) {
          const normalized = normalizeCopilotTool(tr.name, (tr.arguments as Record<string, unknown>) ?? {});
          // Skip internal CLI tools that have no frontend representation
          if (normalized.name === null) continue;
          const block: ContentBlock & { type: "tool_use" } = {
            type: "tool_use",
            id: tr.toolCallId,
            name: normalized.name,
            input: normalized.input,
          };
          // Cache so tool.execution_complete can close the same block
          state.pendingToolUses.set(tr.toolCallId, block);
          yield { type: "block.start", block };
        }
      }
      return;
    }

    case "tool.execution_complete": {
      const { toolCallId, result, success } = event.data;
      // Close the tool_use block that block.start opened
      const toolUseBlock = state.pendingToolUses.get(toolCallId);
      if (toolUseBlock) {
        state.pendingToolUses.delete(toolCallId);
        yield { type: "block.done", block: toolUseBlock };
        // Only emit tool_result for tools that were surfaced to the frontend
        const output = result?.content ?? (success ? "" : "Tool execution failed");
        const resultBlock: ContentBlock = {
          type: "tool_result",
          tool_use_id: toolCallId,
          output,
          error: !success || undefined,
        };
        yield { type: "block.done", block: resultBlock };
      } else {
        // No pending entry: either the tool was an internal tool (skipped intentionally)
        // or an unexpected toolCallId mismatch — log for diagnosability
        logger.debug(`tool.execution_complete: no pending tool_use for toolCallId=${toolCallId} (skipped or mismatch)`);
      }
      return;
    }

    case "assistant.usage": {
      const d = event.data;
      state.usage.cost += d.cost ?? 0;
      state.usage.input_tokens += d.inputTokens ?? 0;
      state.usage.output_tokens += d.outputTokens ?? 0;
      state.usage.cache_read_input_tokens += d.cacheReadTokens ?? 0;
      state.usage.cache_creation_input_tokens += d.cacheWriteTokens ?? 0;
      return;
    }

    case "session.idle": {
      // All LLM calls and tool executions are done — emit final turn.end
      if (state.turnOpen) {
        state.turnOpen = false;
        const { cost, ...usageRest } = state.usage;
        yield { type: "turn.end", cost, usage: usageRest };
      }
      return;
    }

    case "session.error": {
      const { errorType, message } = event.data;
      state.turnOpen = false;
      if (errorType === "rate_limit" || errorType === "quota") {
        yield { type: "turn.rate_limit", status: "rejected" };
      } else {
        yield { type: "turn.error", code: errorType ?? undefined, detail: message ?? "Unknown error" };
      }
      return;
    }

    default:
      return;
  }
}

function convertSdkHistory(sdkEvents: SessionEvent[]): HistoryEvent[] {
  const historyEvents: HistoryEvent[] = [];
  const state: MapState = { turnOpen: false, usage: makeUsage(), pendingToolUses: new Map() };
  let counter = 0;
  for (const sdkEvent of sdkEvents) {
    for (const agentEvent of mapCopilotEvent(sdkEvent, state)) {
      historyEvents.push({
        id: `copilot-hist-${++counter}`,
        event: agentEvent,
        timestamp: new Date().toISOString(),
      });
    }
  }
  return historyEvents;
}

export const copilotProvider: AgentProvider = {
  name: "copilot",
  label: "GitHub Copilot",

  async checkAvailability() {
    if (!readGhToken()) return { status: "unauthorized" as const, detail: "GitHub CLI is not authenticated" };
    try {
      return availabilityFromUsage(await this.fetchUsage!());
    } catch (err) {
      return availabilityFromUsageError(err, "GitHub Copilot");
    }
  },

  async listModels(): Promise<RuntimeModel[]> {
    const { CopilotClient } = await sdk();
    const client = new CopilotClient({ useLoggedInUser: true });
    await client.start();
    try {
      const models = await client.listModels();
      return models.map((model) => ({
        id: model.id,
        name: model.name,
        context_window: model.capabilities.limits.max_context_window_tokens,
        supports: {
          vision: model.capabilities.supports.vision,
          reasoning_effort: model.capabilities.supports.reasoningEffort,
        },
        supported_reasoning_efforts: model.supportedReasoningEfforts,
        default_reasoning_effort: model.defaultReasoningEffort,
      }));
    } finally {
      await client.stop();
    }
  },

  async execute(opts: ExecuteOpts): Promise<AgentHandle> {
    const { CopilotClient, approveAll } = await sdk();
    const systemPrompt = opts.systemPromptFile ? readFileSync(opts.systemPromptFile, "utf-8") : undefined;

    const client = new CopilotClient({
      cwd: opts.cwd,
      env: opts.env,
      useLoggedInUser: true,
    });

    await client.start();
    logger.debug("CopilotClient started");

    if (opts.resume && !opts.resumeToken) {
      throw new Error("copilot: resume requested but no resumeToken provided");
    }

    const sessionConfig = {
      sessionId: opts.resume ? undefined : opts.sessionId,
      model: opts.model,
      workingDirectory: opts.cwd,
      onPermissionRequest: approveAll,
      ...(systemPrompt ? { systemMessage: { content: systemPrompt } } : {}),
    };

    const session =
      opts.resume && opts.resumeToken ? await client.resumeSession(opts.resumeToken, sessionConfig) : await client.createSession(sessionConfig);

    logger.debug(`Session created: ${session.sessionId}`);

    // Register for getHistory() to reuse during execution
    activeSessions.set(session.sessionId, session);

    // Bridge SDK events → AsyncIterable<AgentEvent> via a bounded queue
    const queue: AgentEvent[] = [];
    let done = false;
    let queueError: unknown = null;
    let notify: (() => void) | null = null;

    const push = (...events: AgentEvent[]) => {
      queue.push(...events);
      notify?.();
    };

    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      queueError = err ?? null;
      notify?.();
    };

    const state: MapState = { turnOpen: false, usage: makeUsage(), pendingToolUses: new Map() };
    let idleSeen = false;

    const unsubscribe = session.on((event) => {
      try {
        for (const ev of mapCopilotEvent(event as SessionEvent, state)) {
          push(ev);
        }
        // End the stream once session.idle is received
        if (event.type === "session.idle") {
          idleSeen = true;
          finish();
        } else if (event.type === "session.error") {
          finish();
        } else if (event.type === "session.shutdown") {
          if (!idleSeen) finish(new Error("Session shut down unexpectedly"));
          else finish();
        }
      } catch (err) {
        finish(err);
      }
    });

    // Send the task context to the session
    await session.send({ prompt: opts.taskContext });

    const events = (async function* () {
      try {
        while (true) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (done) break;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
        if (queueError) throw queueError;
        // Drain any remaining items
        while (queue.length > 0) {
          yield queue.shift()!;
        }
      } finally {
        activeSessions.delete(session.sessionId);
        unsubscribe();
        await session.disconnect().catch(() => {});
        await client.stop().catch(() => {});
      }
    })();

    let aborted = false;
    return {
      events,
      async abort() {
        if (aborted) return;
        aborted = true;
        await session.abort().catch(() => {});
        finish();
      },
      async send(message: string) {
        await session.send({ prompt: message });
      },
      getResumeToken() {
        return session.sessionId;
      },
    };
  },

  async fetchUsage(): Promise<UsageInfo | null> {
    const token = readGhToken();
    if (!token) return null;

    let res: Response;
    try {
      res = await fetch(COPILOT_USER_API, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new UsageFetchError(`copilot usage request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!res.ok) {
      throw new UsageFetchError(`copilot usage API returned ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
      });
    }

    type QuotaSnapshot = {
      percent_remaining: number;
      unlimited: boolean;
      remaining: number;
      entitlement: number;
    };
    const data = (await res.json()) as {
      quota_reset_date_utc?: string;
      quota_snapshots?: Record<string, QuotaSnapshot>;
    };

    const resets_at = data.quota_reset_date_utc ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const snapshots = data.quota_snapshots ?? {};
    const QUOTA_LABELS: Record<string, string> = {
      premium_interactions: "Premium",
      chat: "Chat",
      completions: "Completions",
    };

    const windows: UsageWindow[] = Object.entries(QUOTA_LABELS)
      .filter(([key]) => snapshots[key] && !snapshots[key].unlimited)
      .map(([key, label]) => ({
        runtime: "copilot" as const,
        label,
        utilization: Number((100 - snapshots[key].percent_remaining).toFixed(2)),
        resets_at,
      }));

    // No limited quotas means all-unlimited plan (free/student/education) — not applicable
    if (windows.length === 0) return null;

    return { windows, updated_at: new Date().toISOString() };
  },

  async getHistory(_sessionId, resumeToken): Promise<HistoryEvent[]> {
    if (!resumeToken) return [];

    // If the session is currently active (execute() is running), reuse it directly
    const activeSession = activeSessions.get(resumeToken);
    if (activeSession) {
      const sdkEvents = await activeSession.getMessages();
      return convertSdkHistory(sdkEvents);
    }

    // Otherwise start a fresh client just to read history, then tear it down
    const { CopilotClient, approveAll } = await sdk();
    const client = new CopilotClient({ useLoggedInUser: true });
    await client.start();
    try {
      const session = await client.resumeSession(resumeToken, { onPermissionRequest: approveAll });
      try {
        const sdkEvents = await session.getMessages();
        return convertSdkHistory(sdkEvents);
      } finally {
        await session.disconnect().catch(() => {});
      }
    } finally {
      await client.stop().catch(() => {});
    }
  },
};
