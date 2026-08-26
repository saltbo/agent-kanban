import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { SubtaskStatus } from "@agent-kanban/shared";
import { ToolName } from "@agent-kanban/shared";
import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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

async function sdk() {
  try {
    return await import("@anthropic-ai/claude-agent-sdk");
  } catch {
    throw new Error("@anthropic-ai/claude-agent-sdk is not installed; provider features need it on this host");
  }
}

const SUBTASK_STATUSES: readonly SubtaskStatus[] = ["completed", "failed", "stopped"] as const;

function coerceSubtaskStatus(raw: unknown): SubtaskStatus {
  return (SUBTASK_STATUSES as readonly string[]).includes(raw as string) ? (raw as SubtaskStatus) : "stopped";
}

const logger = createLogger("claude");

const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const USAGE_API = "https://api.anthropic.com/api/oauth/usage";

const CLAUDE_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5-Hour",
  seven_day: "7-Day",
  seven_day_sonnet: "7-Day Sonnet",
  seven_day_opus: "7-Day Opus",
};

let cachedToken: string | null = null;

function parseToken(raw: string): string | null {
  const creds = JSON.parse(raw);
  return creds.claudeAiOauth?.accessToken || null;
}

function readOAuthToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    if (platform() === "darwin") {
      const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', { stdio: ["pipe", "pipe", "pipe"] })
        .toString()
        .trim();
      cachedToken = parseToken(raw);
    } else {
      cachedToken = parseToken(readFileSync(CREDENTIALS_PATH, "utf-8"));
    }
    return cachedToken;
  } catch {
    return null;
  }
}

/** Stamp `parent_id` onto a block only when set, to keep wire format clean. */
function withParent<T extends ContentBlock>(block: T, parentId: string | null | undefined): T {
  return parentId ? ({ ...block, parent_id: parentId } as T) : block;
}

/** Remap Claude's native snake_case tool input fields to our camelCase canonical format. */
function normalizeClaudeToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case ToolName.Read:
      return { ...input, filePath: input.file_path ?? input.filePath };
    case ToolName.Write:
      return { ...input, filePath: input.file_path ?? input.filePath, content: input.content };
    case ToolName.Edit:
      return {
        ...input,
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll,
      };
    case ToolName.MultiEdit: {
      const edits = Array.isArray(input.edits)
        ? input.edits.map((e: Record<string, unknown>) => ({
            ...e,
            oldString: e.old_string ?? e.oldString,
            newString: e.new_string ?? e.newString,
            replaceAll: e.replace_all ?? e.replaceAll,
          }))
        : input.edits;
      return { ...input, filePath: input.file_path ?? input.filePath, edits };
    }
    case ToolName.Grep:
      return { ...input, outputMode: input.output_mode ?? input.outputMode };
    case ToolName.Agent:
      return { ...input, subagentType: input.subagent_type ?? input.subagentType };
    case ToolName.NotebookEdit:
      return {
        ...input,
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellId: input.cell_id ?? input.cellId,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode,
        newSource: input.new_source ?? input.newSource,
      };
    default:
      return input;
  }
}

/** Map a single SDK message to an AgentEvent (or null to skip). */
function mapContentBlock(block: SDKAssistantMessage["message"]["content"][number], parentId: string | null | undefined): ContentBlock | null {
  switch (block.type) {
    case "thinking":
      return block.thinking ? withParent({ type: "thinking", text: block.thinking }, parentId) : null;
    case "tool_use":
      return withParent(
        { type: "tool_use", id: block.id, name: block.name, input: normalizeClaudeToolInput(block.name, block.input as Record<string, unknown>) },
        parentId,
      );
    case "text":
      return block.text ? withParent({ type: "text", text: block.text }, parentId) : null;
    default:
      return null;
  }
}

function mapToolResult(msg: SDKUserMessage): ContentBlock[] {
  const content = msg.message.content;
  if (typeof content === "string") return [];
  const parentId = msg.parent_tool_use_id;
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "tool_result") {
      let output: string | undefined;
      if (typeof block.content === "string") {
        output = block.content;
      } else if (Array.isArray(block.content)) {
        output = block.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      }
      blocks.push(withParent({ type: "tool_result", tool_use_id: block.tool_use_id, output, error: block.is_error }, parentId));
    }
  }
  return blocks;
}

// User messages from the Claude SDK carry either tool_result blocks (assistant
// attribution) or plain text (real human input — initial prompt or chat reply).
// Extract the latter so history can surface it as a role:user message.
function extractUserText(msg: SDKUserMessage): string {
  const content = msg.message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Map SDK system task_* messages → our subtask.* events.
 * SDK subtypes: task_started | task_progress | task_notification.
 */
function mapTaskSystemMessage(msg: any): AgentEvent | null {
  const tid = msg.tool_use_id;
  if (!tid) return null;
  switch (msg.subtype) {
    case "task_started":
      return { type: "subtask.start", tool_use_id: tid, description: msg.description, kind: msg.task_type };
    case "task_progress":
      return {
        type: "subtask.progress",
        tool_use_id: tid,
        summary: msg.summary,
        last_tool: msg.last_tool_name,
        tokens: msg.usage?.total_tokens,
        duration_ms: msg.usage?.duration_ms,
      };
    case "task_notification":
      return {
        type: "subtask.end",
        tool_use_id: tid,
        status: coerceSubtaskStatus(msg.status),
        summary: msg.summary,
        tokens: msg.usage?.total_tokens,
        duration_ms: msg.usage?.duration_ms,
      };
    default:
      return null;
  }
}

/**
 * Map a single SDK message to a list of AgentEvents (0..N).
 *
 * Most SDK message types produce a single event, but `user` messages can
 * contain both plain text (human input) and tool_result blocks (assistant
 * attribution). Those must emit two events in order — user text first, then
 * the tool_result-bearing message — so the UI can render human turn before
 * the tool output that follows it.
 */
export function mapSDKMessage(msg: SDKMessage): AgentEvent[] {
  switch (msg.type) {
    case "rate_limit_event": {
      const info = msg.rate_limit_info;
      if (info.status === "rejected" || info.status === "allowed") {
        const resetAt = info.resetsAt ? new Date(info.resetsAt * 1000).toISOString() : undefined;
        const overage = info.overageStatus
          ? {
              status: info.overageStatus as "allowed" | "rejected",
              resetAt: info.overageResetsAt ? new Date(info.overageResetsAt * 1000).toISOString() : undefined,
            }
          : undefined;
        return [
          {
            type: "turn.rate_limit",
            status: info.status,
            resetAt,
            rateLimitType: info.rateLimitType,
            isUsingOverage: info.isUsingOverage,
            overage,
          },
        ];
      }
      if (info.status === "allowed_warning") {
        logger.warn(`Rate limit warning: ${info.rateLimitType} at ${((info.utilization ?? 0) * 100).toFixed(0)}%`);
      }
      return [];
    }

    case "assistant": {
      if (msg.error === "rate_limit") {
        return [{ type: "turn.rate_limit", status: "rejected", resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }];
      }
      if (msg.error) {
        const contentText = (msg.message?.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ")
          .slice(0, 500);
        const detail = contentText || msg.error;
        return [{ type: "turn.error", code: msg.error, detail }];
      }
      const parentId = msg.parent_tool_use_id;
      const blocks = (msg.message.content ?? []).map((b) => mapContentBlock(b, parentId)).filter((b): b is ContentBlock => b !== null);
      return blocks.length > 0 ? [{ type: "message", blocks }] : [];
    }

    case "user": {
      // Order matters: the human text precedes any tool_result blocks from
      // the same SDK message so consumers render the user turn first.
      const events: AgentEvent[] = [];
      const userText = extractUserText(msg);
      if (userText) events.push({ type: "message.user", text: userText });
      const blocks = mapToolResult(msg);
      if (blocks.length > 0) events.push({ type: "message", blocks });
      return events;
    }

    case "result": {
      const text = msg.subtype === "success" ? msg.result : undefined;
      return [{ type: "turn.end", text, cost: msg.total_cost_usd || 0, usage: msg.usage as Record<string, any> }];
    }

    case "system": {
      const event = mapTaskSystemMessage(msg);
      return event ? [event] : [];
    }

    default:
      return [];
  }
}

/** Map a stream_event's content_block to a ContentBlock (or null to skip). */
function mapStreamBlock(block: { type: string; [k: string]: unknown }, parentId: string | null | undefined): ContentBlock | null {
  switch (block.type) {
    case "tool_use":
      return withParent(
        {
          type: "tool_use",
          id: block.id as string,
          name: block.name as string,
          input: normalizeClaudeToolInput(block.name as string, block.input as Record<string, unknown>),
        },
        parentId,
      );
    case "thinking":
      return block.thinking ? withParent({ type: "thinking", text: block.thinking as string }, parentId) : null;
    case "text":
      return block.text ? withParent({ type: "text", text: block.text as string }, parentId) : null;
    default:
      return null;
  }
}

/**
 * Streaming mapper: yields fine-grained events for real-time UI.
 * One turn.start per query() call. Blocks stream in between.
 * turn.end emitted when SDK yields `result`.
 */
export function* mapSDKMessageStream(msg: SDKMessage, turnOpen: { value: boolean }, rateLimitSeen?: { value: boolean }): Generator<AgentEvent> {
  if (msg.type === "stream_event") {
    const partial = msg as SDKPartialAssistantMessage;
    const evt = partial.event;
    if (evt.type === "content_block_start") {
      const block = mapStreamBlock(evt.content_block as unknown as { type: string; [k: string]: unknown }, partial.parent_tool_use_id);
      if (!block) return;

      // Only open a main turn for non-subtask blocks. Subtask blocks belong to
      // their parent Task tool card, not the main agent stream.
      if (!block.parent_id && !turnOpen.value) {
        yield { type: "turn.start" };
        turnOpen.value = true;
      }
      yield { type: "block.start", block };
    }
    return;
  }

  if (msg.type === "assistant") {
    const assistantMsg = msg as SDKAssistantMessage;
    if (assistantMsg.error) {
      if (turnOpen.value) {
        turnOpen.value = false;
      }
      // Skip the fallback rate_limit event if the SDK already sent a
      // rate_limit_event with real reset times — avoids a duplicate that
      // overwrites the accurate window with a 60-min fallback.
      if (assistantMsg.error === "rate_limit" && rateLimitSeen?.value) {
        return;
      }
      yield* mapSDKMessage(msg);
      return;
    }

    // Internal API round-trip complete — emit block.done for each finalized block
    const parentId = assistantMsg.parent_tool_use_id;
    const blocks = (assistantMsg.message.content ?? []).map((b) => mapContentBlock(b, parentId)).filter((b): b is ContentBlock => b !== null);

    const hasMainBlock = blocks.some((b) => !b.parent_id);
    if (!turnOpen.value && hasMainBlock) {
      yield { type: "turn.start" };
      turnOpen.value = true;
    }

    for (const block of blocks) {
      yield { type: "block.done", block };
    }
    return;
  }

  if (msg.type === "user") {
    // Tool results — emit block.done, turn stays open (more API calls may follow)
    const blocks = mapToolResult(msg as SDKUserMessage);
    for (const block of blocks) {
      yield { type: "block.done", block };
    }
    return;
  }

  if (msg.type === "result") {
    // Turn complete — reset per-turn state and emit turn.end
    turnOpen.value = false;
    if (rateLimitSeen !== undefined) rateLimitSeen.value = false;
    const text = (msg as any).subtype === "success" ? (msg as any).result : undefined;
    yield { type: "turn.end", text, cost: (msg as any).total_cost_usd || 0, usage: (msg as any).usage };
    return;
  }

  // Everything else (rate_limit_event, etc.) — delegate
  for (const event of mapSDKMessage(msg)) {
    if (event.type === "turn.rate_limit" && rateLimitSeen !== undefined) {
      rateLimitSeen.value = true;
    }
    yield event;
  }
}

export const claudeProvider: AgentProvider = {
  name: "claude",
  label: "Claude Code",

  async checkAvailability() {
    if (!readOAuthToken()) return { status: "unauthorized" as const, detail: "Claude Code is not logged in" };
    try {
      return availabilityFromUsage(await this.fetchUsage!());
    } catch (err) {
      return availabilityFromUsageError(err, "Claude Code");
    }
  },

  async listModels(): Promise<RuntimeModel[]> {
    const { query } = await sdk();
    const q = query({
      prompt: "",
      options: {
        cwd: process.cwd(),
        env: process.env as Record<string, string>,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
      },
    });
    try {
      const models = await q.supportedModels();
      return models.map((model) => ({
        id: model.value,
        name: model.displayName,
        description: model.description,
        supports: {
          effort: model.supportsEffort ?? false,
          adaptive_thinking: model.supportsAdaptiveThinking ?? false,
          fast_mode: model.supportsFastMode ?? false,
          auto_mode: model.supportsAutoMode ?? false,
        },
        supported_reasoning_efforts: model.supportedEffortLevels,
      }));
    } finally {
      q.close();
    }
  },

  async execute(opts: ExecuteOpts): Promise<AgentHandle> {
    const { query } = await sdk();
    const systemPrompt = opts.systemPromptFile ? readFileSync(opts.systemPromptFile, "utf-8") : undefined;
    const abortController = new AbortController();

    const q = query({
      prompt: opts.taskContext,
      options: {
        sessionId: opts.resume ? undefined : opts.sessionId,
        resume: opts.resume ? opts.sessionId : undefined,
        cwd: opts.cwd,
        env: opts.env,
        systemPrompt,
        model: opts.model,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        includePartialMessages: true,
      },
    });

    const events = (async function* () {
      const turnOpen = { value: false };
      const rateLimitSeen = { value: false };
      let activeSubtasks = 0;
      let resultSeen = false;
      for await (const msg of q) {
        if (msg.type === "system" && (msg as any).subtype === "task_started") activeSubtasks++;
        if (msg.type === "system" && (msg as any).subtype === "task_notification") activeSubtasks = Math.max(0, activeSubtasks - 1);
        yield* mapSDKMessageStream(msg, turnOpen, rateLimitSeen);
        if (msg.type === "result") resultSeen = true;
        if (resultSeen && activeSubtasks <= 0) break;
      }
      q.close();
    })();

    let aborted = false;
    return {
      events,
      async abort() {
        if (aborted) return;
        aborted = true;
        q.close();
      },
      async send(message: string) {
        const userMsg = async function* () {
          yield {
            type: "user" as const,
            message: { role: "user" as const, content: message },
            parent_tool_use_id: null,
          };
        };
        await q.streamInput(userMsg());
      },
    };
  },

  async fetchUsage(): Promise<UsageInfo | null> {
    const token = readOAuthToken();
    if (!token) return null;

    let res: Response;
    try {
      res = await fetch(USAGE_API, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new UsageFetchError(`claude usage request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!res.ok) {
      // 401 means the cached OAuth token is stale (user re-authed, rotation,
      // expiry). Drop the in-memory copy so the next poll re-reads from the
      // keychain instead of looping on a dead token forever.
      if (res.status === 401) cachedToken = null;
      throw new UsageFetchError(`claude usage API returned ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
      });
    }

    const data = (await res.json()) as Record<string, { utilization: number; resets_at: string }>;
    const windows: UsageWindow[] = Object.entries(CLAUDE_WINDOW_LABELS)
      .filter(([key]) => data[key])
      .map(([key, label]) => ({
        runtime: "claude",
        label,
        resets_at: data[key].resets_at,
        utilization: normalizeUsagePercent(data[key].utilization),
      }));
    return { windows, updated_at: new Date().toISOString() };
  },

  async getHistory(sessionId) {
    const { getSessionMessages } = await sdk();
    const messages = await getSessionMessages(sessionId);
    const events: HistoryEvent[] = [];
    let counter = 0;
    for (const msg of messages) {
      const sdkLike = { ...msg, message: msg.message } as unknown as SDKMessage;
      const baseId = msg.uuid || `claude-hist-${++counter}`;
      const timestamp = new Date().toISOString();
      // User SDK messages can expand into two events (message.user + message
      // with tool_result). Suffix their ids so both are stable even when only
      // one of the two is emitted.
      const isUser = sdkLike.type === "user";
      for (const event of mapSDKMessage(sdkLike)) {
        const id = isUser ? `${baseId}-${event.type === "message.user" ? "user" : "tool"}` : baseId;
        events.push({ id, event, timestamp });
      }
    }
    return events;
  },
};

function normalizeUsagePercent(value: number): number {
  return value < 1 ? value * 100 : value;
}
