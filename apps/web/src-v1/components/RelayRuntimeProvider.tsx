import { type AgentEvent, type ContentBlock, ToolName } from "@agent-kanban/shared";
import { AssistantRuntimeProvider, type ThreadMessageLike, useExternalStoreRuntime } from "@assistant-ui/react";
import { type ReactNode, useCallback, useMemo } from "react";
import type { AgentStatus, RelayEvent } from "../hooks/useSessionRelay";
import { useSessionRelay } from "../hooks/useSessionRelay";

// ─── Event → Message Conversion ───

type ContentPart = { type: "text"; text: string } | { type: "reasoning"; text: string } | ToolCallPart;

// Subtask (subagent) child events captured inside a Agent tool call. Not assistant-ui
// parts — just a serializable summary rendered by TaskToolUI.
export type SubtaskChild =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  | { kind: "tool_result"; tool_use_id: string; output?: string; error?: boolean };

export interface TaskToolResult {
  text?: string; // final summary (from tool_result on the outer turn)
  error?: boolean;
  children: SubtaskChild[]; // streamed inner events from the subagent
  meta?: {
    description?: string;
    status?: "running" | "completed" | "failed" | "stopped";
    last_tool?: string;
    tokens?: number;
    duration_ms?: number;
  };
}

type ToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
};

type NormalizedToolCall = {
  name: string;
  input: Record<string, unknown>;
};

export function convertEvents(events: RelayEvent[], agentStatus: AgentStatus): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = [];
  const toolCallMap = new Map<string, ToolCallPart>();
  // Nested subtasks: when a subagent spawns another subagent, the inner Agent's
  // tool_use lives inside the outer Task's children (not in toolCallMap). Map
  // any nested tool_use_id we observe → its top-level Agent id, so subsequent
  // descendant blocks can still be routed to the outermost Agent card.
  const subtaskRoot = new Map<string, string>();

  function resolveTaskRoot(parentId: string): string | undefined {
    if (toolCallMap.has(parentId)) return parentId;
    const redirect = subtaskRoot.get(parentId);
    if (redirect && toolCallMap.has(redirect)) return redirect;
    return undefined;
  }

  // Current assistant message being built (streaming turn or legacy accumulation)
  let currentParts: ContentPart[] = [];
  let currentId: string | null = null;
  let currentTimestamp: string | null = null;
  let turnRunning = false;

  function ensureTaskResult(tc: ToolCallPart): TaskToolResult {
    if (!tc.result || typeof tc.result !== "object" || !("children" in (tc.result as object))) {
      tc.result = { children: [] } as TaskToolResult;
    }
    return tc.result as TaskToolResult;
  }

  function appendSubtaskChild(parentId: string, child: SubtaskChild) {
    const rootId = resolveTaskRoot(parentId);
    if (!rootId) {
      // Parent Agent tool_use is unknown. Shouldn't happen in a well-ordered
      // stream (block.done for the Agent arrives before its subagent's blocks),
      // but log so data loss is diagnosable rather than silent.
      console.warn("[convertEvents] subtask block dropped — unknown parent", parentId, child.kind);
      return;
    }
    const tc = toolCallMap.get(rootId)!;
    const r = ensureTaskResult(tc);
    r.children.push(child);
    // If this child is itself a tool_use (potentially another Agent), record a
    // redirect so its descendants flatten into the same top-level Agent card.
    if (child.kind === "tool_use") {
      subtaskRoot.set(child.id, rootId);
    }
  }

  function flushAssistant(status: ThreadMessageLike["status"]) {
    // Only create a message if there are content parts to flush
    if (currentParts.length === 0) return;

    messages.push({
      id: currentId!,
      role: "assistant",
      content: currentParts as ThreadMessageLike["content"],
      createdAt: new Date(currentTimestamp!),
      status,
    });

    // Reset state for next message
    currentParts = [];
    currentId = null;
    currentTimestamp = null;
    turnRunning = false;
  }

  function ensureCurrentTurn(re: RelayEvent) {
    // Initialize turn state if this is the first event in the turn
    if (!currentId) {
      currentId = re.id;
      currentTimestamp = re.timestamp;
    }
  }

  // If a block belongs to a subtask (parent_id set), route it into the parent
  // Agent tool card's `children` instead of the main turn. Returns true if handled.
  function routeSubtaskBlock(block: { type: string; [k: string]: any }): boolean {
    const parentId: string | undefined = block.parent_id;
    if (!parentId) return false;
    switch (block.type) {
      case "thinking":
        if (block.text) appendSubtaskChild(parentId, { kind: "thinking", text: block.text });
        return true;
      case "text":
        if (block.text) appendSubtaskChild(parentId, { kind: "text", text: block.text });
        return true;
      case "tool_use":
        appendSubtaskChild(parentId, { kind: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
        return true;
      case "tool_result":
        appendSubtaskChild(parentId, {
          kind: "tool_result",
          tool_use_id: block.tool_use_id,
          output: block.output,
          error: block.error,
        });
        return true;
      default:
        return true; // unknown subtask block — drop, don't leak into main stream
    }
  }

  function mapBlock(block: { type: string; [k: string]: any }): ContentPart | null {
    switch (block.type) {
      case "thinking":
        return { type: "reasoning", text: block.text ?? "" };
      case "tool_use": {
        const tc: ToolCallPart = {
          type: "tool-call",
          toolCallId: block.id,
          toolName: block.name,
          args: block.input ?? {},
        };
        toolCallMap.set(block.id, tc);
        return tc;
      }
      case "text":
        return { type: "text", text: block.text ?? "" };
      default:
        return null;
    }
  }

  function appendPart(part: ContentPart) {
    const previous = currentParts[currentParts.length - 1];
    if ((part.type === "text" || part.type === "reasoning") && previous?.type === part.type) {
      previous.text += part.text;
      return;
    }
    currentParts.push(part);
  }

  function updateOrAppend(block: { type: string; [k: string]: any }) {
    if (block.type === "tool_result") {
      const tc = toolCallMap.get(block.tool_use_id);
      if (tc) {
        // For Agent tool: stamp the subagent's final text into result.text (keep children/meta)
        if (tc.toolName === "Agent") {
          const r = ensureTaskResult(tc);
          r.text = block.output;
          r.error = block.error;
        } else {
          tc.result = block.error ? { error: block.output ?? "Unknown error" } : (block.output ?? "Done");
        }
      } else if (subtaskRoot.has(block.tool_use_id)) {
        appendSubtaskChild(block.tool_use_id, {
          kind: "tool_result",
          tool_use_id: block.tool_use_id,
          output: block.output,
          error: block.error,
        });
      }
      return;
    }

    // For text/thinking/tool_use done events: find an existing part to update, or append
    if (block.type === "tool_use") {
      const existing = toolCallMap.get(block.id);
      if (existing) {
        // Update with final args
        existing.args = block.input ?? existing.args;
        return;
      }
    }

    // For thinking/text blocks, find the last empty part of the same type
    const targetType = block.type === "thinking" ? "reasoning" : block.type;
    if (targetType === "reasoning" || targetType === "text") {
      // Search backwards more efficiently - early exit when found
      for (let i = currentParts.length - 1; i >= 0; i--) {
        const p = currentParts[i];
        if (p.type === targetType && p.text === "") {
          p.text = block.text ?? "";
          return;
        }
        // Stop searching if we hit a different type (parts are added in order)
        if (p.type !== targetType) break;
      }
    }

    // Fallback: append as new part
    const part = mapBlock(block);
    if (part) appendPart(part);
  }

  for (const re of events) {
    const { event } = re;

    // ── Streaming turn lifecycle ──

    if (event.type === "turn.start") {
      flushAssistant({ type: "complete", reason: "unknown" });
      currentId = re.id;
      currentTimestamp = re.timestamp;
      turnRunning = true;
      continue;
    }

    if (event.type === "block.start") {
      if (routeSubtaskBlock(event.block as any)) continue;
      ensureCurrentTurn(re);
      turnRunning = true;
      const part = mapBlock(event.block);
      if (part) appendPart(part);
      continue;
    }

    if (event.type === "block.done") {
      if (routeSubtaskBlock(event.block as any)) continue;
      ensureCurrentTurn(re);
      updateOrAppend(event.block);
      continue;
    }

    // ── Subtask lifecycle (attach meta to parent Agent tool card) ──
    if (event.type === "subtask.start" || event.type === "subtask.progress" || event.type === "subtask.end") {
      const tc = toolCallMap.get(event.tool_use_id);
      if (tc) {
        const r = ensureTaskResult(tc);
        r.meta = { ...(r.meta ?? {}) };
        if (event.type === "subtask.start") {
          r.meta.status = "running";
          if (event.description) r.meta.description = event.description;
        } else if (event.type === "subtask.progress") {
          r.meta.status = "running";
          if (event.last_tool) r.meta.last_tool = event.last_tool;
          if (event.tokens != null) r.meta.tokens = event.tokens;
          if (event.duration_ms != null) r.meta.duration_ms = event.duration_ms;
        } else {
          // subtask.end — the canonical final text arrives separately via the
          // outer Agent's tool_result. Only fall back to `summary` for non-success
          // terminations (failed/stopped) where no tool_result will follow.
          r.meta.status = event.status;
          if (event.tokens != null) r.meta.tokens = event.tokens;
          if (event.duration_ms != null) r.meta.duration_ms = event.duration_ms;
          if (event.status !== "completed" && event.summary && !r.text) {
            r.text = event.summary;
          }
        }
      }
      continue;
    }

    // ── Legacy events (history, Gemini) ──

    if (event.type === "message.user") {
      flushAssistant({ type: "complete", reason: "unknown" });
      messages.push({
        id: re.id,
        role: "user",
        content: [{ type: "text", text: event.text }],
        createdAt: new Date(re.timestamp),
      });
      continue;
    }

    if (event.type === "message") {
      const snapshotMessageId = typeof (event as any).message_id === "string" ? (event as any).message_id : null;
      if ((event as any).snapshot === true) {
        if (currentId && currentId !== (snapshotMessageId ?? re.id)) {
          flushAssistant({ type: "complete", reason: "unknown" });
        }
        currentId = snapshotMessageId ?? re.id;
        currentTimestamp = re.timestamp;
        currentParts = [];
        turnRunning = true;
      }
      for (const block of event.blocks) {
        if (routeSubtaskBlock(block as any)) continue;
        ensureCurrentTurn(re);
        if (block.type === "tool_result") {
          updateOrAppend(block as any);
        } else {
          const part = mapBlock(block);
          if (part) appendPart(part);
        }
      }
      continue;
    }

    // ── Turn terminal events ──

    if (event.type === "turn.end") {
      flushAssistant({ type: "complete", reason: "unknown" });
      if (event.text || event.cost != null) {
        messages.push({
          id: re.id,
          role: "assistant",
          content: [
            {
              type: "text",
              text: event.text
                ? `Done${event.cost != null ? ` ($${event.cost.toFixed(4)})` : ""} — ${event.text.slice(0, 120)}`
                : `Done${event.cost != null ? ` ($${event.cost.toFixed(4)})` : ""}`,
            },
          ],
          createdAt: new Date(re.timestamp),
          status: { type: "complete", reason: "stop" },
        });
      }
      continue;
    }

    if (event.type === "turn.error") {
      flushAssistant({ type: "complete", reason: "unknown" });
      messages.push({
        id: re.id,
        role: "assistant",
        content: [{ type: "text", text: `Error: ${event.detail}` }],
        createdAt: new Date(re.timestamp),
        status: { type: "incomplete", reason: "error" },
      });
      continue;
    }

    if (event.type === "turn.rate_limit" && event.status === "rejected") {
      flushAssistant({ type: "complete", reason: "unknown" });
      const detail = event.isUsingOverage
        ? "continuing on extra usage"
        : event.resetAt
          ? `resets at ${new Date(event.resetAt).toLocaleTimeString()}`
          : "reset time unknown";
      messages.push({
        id: re.id,
        role: "assistant",
        content: [{ type: "text", text: `Rate limited — ${detail}` }],
        createdAt: new Date(re.timestamp),
        status: { type: "incomplete", reason: "error" },
      });
    }
  }

  // Flush remaining parts — running if turn is open or agent is working
  const isRunning = turnRunning || agentStatus === "working";
  flushAssistant(isRunning ? { type: "running" } : { type: "complete", reason: "unknown" });

  return messages;
}

// ─── Provider ───

interface RelayRuntimeProviderProps {
  sessionId: string | null;
  taskDone: boolean;
  children: ReactNode;
}

export function RelayRuntimeProvider({ sessionId, taskDone, children }: RelayRuntimeProviderProps) {
  const { events, agentStatus } = useSessionRelay({
    sessionId,
    enabled: !!sessionId,
  });

  const messages = useMemo(() => convertEvents(events, agentStatus), [events, agentStatus]);

  const isRunning = agentStatus === "working" && !taskDone;

  const convertMessage = useCallback((message: ThreadMessageLike): ThreadMessageLike => message, []);

  const onNew = useCallback(async () => {}, []);

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage,
    onNew,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

interface AmaRuntimeProviderProps {
  events: Record<string, unknown>[];
  taskDone: boolean;
  children: ReactNode;
}

export function AmaRuntimeProvider({ events: rawEvents, taskDone, children }: AmaRuntimeProviderProps) {
  const events = useMemo(() => rawEvents.map(amaEventToRelayEvent), [rawEvents]);
  // No session metadata is fetched — events arrive over the socket. A task that is
  // not yet done is treated as actively running for the typing indicator.
  const agentStatus: AgentStatus = taskDone ? "idle" : "working";
  const messages = useMemo(() => convertEvents(events, agentStatus), [events, agentStatus]);
  const isRunning = !taskDone;
  const convertMessage = useCallback((message: ThreadMessageLike): ThreadMessageLike => message, []);
  const onNew = useCallback(async () => {}, []);

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages,
    convertMessage,
    onNew,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

export function amaEventToRelayEvent(raw: Record<string, unknown>): RelayEvent {
  const canonical = canonicalAmaEvent(raw);
  if (!canonical) throw new Error("Invalid AMA SessionEvent: type and payload are required");
  const id = stringValue(raw.id);
  if (!id) throw new Error("Invalid AMA SessionEvent: id is required");
  const timestamp = stringValue(raw.createdAt);
  if (!timestamp) throw new Error("Invalid AMA SessionEvent: createdAt is required");
  const event = canonicalAmaAgentEvent(canonical);
  return {
    id,
    event,
    timestamp,
  };
}

function canonicalAmaEvent(raw: Record<string, unknown>): { type: string; payload: Record<string, unknown> } | null {
  const type = stringValue(raw.type);
  const payload = objectValue(raw.payload);
  return type && payload ? { type, payload } : null;
}

function canonicalAmaAgentEvent(input: { type: string; payload: Record<string, unknown> }): AgentEvent {
  const message = objectValue(input.payload.message);
  switch (input.type) {
    case "runtime.started":
    case "runtime.completed":
    case "usage.recorded":
    case "permission.requested":
    case "permission.resolved":
      return { type: "message", blocks: [] };
    case "turn.started":
      if (message?.role === "user") {
        requireAmaMessageId(message);
        return { type: "message.user", text: textFromCanonicalMessage(message) };
      }
      return { type: "turn.start" };
    case "turn.completed":
      return { type: "turn.end" };
    case "message.started":
    case "message.updated":
    case "message.completed":
      return canonicalMessageEvent(message);
    case "permission.denied":
      return { type: "turn.error", detail: stringValue(input.payload.reason) ?? "Permission denied" };
    case "runtime.error":
      return {
        type: "turn.error",
        code: stringValue(input.payload.code) ?? undefined,
        detail: stringValue(input.payload.message) ?? "Runtime error",
      };
    default:
      return { type: "message", blocks: [] };
  }
}

function canonicalMessageEvent(message: Record<string, unknown> | null): AgentEvent {
  if (!message) throw new Error("Invalid AMA EventRecord: message payload is required");
  const role = stringValue(message.role);
  const messageId = requireAmaMessageId(message);
  if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
    throw new Error("Invalid AMA EventRecord: message.role is required");
  }
  if (role === "user") return { type: "message.user", text: textFromCanonicalMessage(message) };

  const parentToolCallId = stringValue(message.parentToolCallId);
  const blocks = canonicalContentBlocks(Array.isArray(message.content) ? message.content : [], parentToolCallId);
  return {
    type: "message",
    blocks,
    ...(role === "assistant" || role === "system" ? { snapshot: true, message_id: messageId } : {}),
  } as AgentEvent;
}

function canonicalContentBlocks(content: unknown[], parentToolCallId?: string | null): ContentBlock[] {
  return content
    .map((part): ContentBlock | null => {
      const block = objectValue(part);
      switch (block?.type) {
        case "text":
          return withAmaParent({ type: "text", text: stringValue(block.text) ?? "" }, parentToolCallId);
        case "reasoning":
          return withAmaParent({ type: "thinking", text: stringValue(block.text) ?? "" }, parentToolCallId);
        case "tool_call": {
          const toolCall = objectValue(block.toolCall);
          const toolCallId = stringValue(toolCall?.id);
          const toolName = stringValue(toolCall?.name);
          const input = objectValue(toolCall?.input);
          if (!toolCallId || !toolName || !input) {
            throw new Error("Invalid AMA EventRecord: tool_call requires toolCall.id, toolCall.name, and object toolCall.input");
          }
          const normalized = normalizeAmaToolCall(toolName, input);
          return withAmaParent(
            {
              type: "tool_use",
              id: toolCallId,
              name: normalized.name,
              input: normalized.input,
            },
            parentToolCallId,
          );
        }
        case "tool_result": {
          const error = objectValue(block.error);
          const toolCallId = stringValue(block.toolCallId);
          const result = objectValue(block.result);
          if (!toolCallId || !result) {
            throw new Error("Invalid AMA EventRecord: tool_result requires toolCallId and object result");
          }
          return {
            type: "tool_result",
            tool_use_id: toolCallId,
            output: canonicalToolResultText(result),
            error: Boolean(error),
            ...(parentToolCallId && parentToolCallId !== toolCallId ? { parent_id: parentToolCallId } : {}),
          };
        }
        case "image":
          return { type: "text", text: stringValue(block.url) ? `[image] ${stringValue(block.url)}` : "[image]" };
        case "file":
          return { type: "text", text: `[file] ${stringValue(block.path) ?? stringValue(block.name) ?? "attachment"}` };
        default:
          return null;
      }
    })
    .filter((block): block is ContentBlock => block !== null);
}

function withAmaParent<TBlock extends ContentBlock>(block: TBlock, parentToolCallId?: string | null): TBlock {
  return parentToolCallId ? ({ ...block, parent_id: parentToolCallId } as TBlock) : block;
}

function textFromCanonicalMessage(message: Record<string, unknown>): string {
  return canonicalContentBlocks(Array.isArray(message.content) ? message.content : [])
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function requireAmaMessageId(message: Record<string, unknown>): string {
  const messageId = stringValue(message.id);
  if (!messageId) throw new Error("Invalid AMA EventRecord: message.id is required");
  return messageId;
}

function normalizeAmaToolCall(toolName: string, input: Record<string, unknown>): NormalizedToolCall {
  switch (toolName) {
    case "bash":
      return { name: ToolName.Bash, input };
    case "read":
      return {
        name: ToolName.Read,
        input: {
          filePath: input.path,
          offset: input.offset,
          limit: input.limit,
        },
      };
    case "write":
      return {
        name: ToolName.Write,
        input: {
          filePath: input.path,
          content: input.content,
        },
      };
    case "edit":
      return normalizeAmaEditToolCall(input);
    case "grep":
      return { name: ToolName.Grep, input };
    case "find":
      return {
        name: ToolName.Glob,
        input: {
          pattern: input.glob ?? input.pattern,
          path: input.path,
        },
      };
    case "fetch":
      return { name: ToolName.WebFetch, input };
    case "web_search":
      return { name: ToolName.WebSearch, input };
    case "agent":
      return {
        name: ToolName.Agent,
        input: {
          description: input.description ?? "",
          prompt: input.prompt ?? "",
          subagentType: input.subagentName,
        },
      };
    default:
      return { name: toolName, input };
  }
}

function normalizeAmaEditToolCall(input: Record<string, unknown>): NormalizedToolCall {
  const edits = Array.isArray(input.edits) ? input.edits.map(objectValue).filter((edit): edit is Record<string, unknown> => edit !== null) : [];
  if (edits.length === 1) {
    return {
      name: ToolName.Edit,
      input: {
        filePath: input.path,
        oldString: edits[0].oldText,
        newString: edits[0].newText,
      },
    };
  }
  return {
    name: ToolName.MultiEdit,
    input: {
      filePath: input.path,
      edits: edits.map((edit) => ({
        oldString: edit.oldText,
        newString: edit.newText,
      })),
    },
  };
}

function canonicalToolResultText(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const stdout = stringValue(result.stdout);
  const stderr = stringValue(result.stderr);
  const output = stringValue(result.output);
  const content = Array.isArray(result.content)
    ? result.content
        .map((part) => {
          const block = objectValue(part);
          if (block?.type === "text") return stringValue(block.text);
          if (block?.type === "json") return JSON.stringify(block.value);
          if (block?.type === "file") return stringValue(block.path) ?? stringValue(block.name);
          if (block?.type === "image") return stringValue(block.url) ?? "[image]";
          return null;
        })
        .filter((part): part is string => Boolean(part))
    : [];
  const exitCode = result.exit_code ?? result.exitCode;
  const parts = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(stderr);
  if (output) parts.push(output);
  parts.push(...content);
  if (parts.length > 0) return parts.join("\n");
  if (exitCode !== undefined && exitCode !== null) return `exit_code: ${String(exitCode)}`;
  return JSON.stringify(result);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
}
