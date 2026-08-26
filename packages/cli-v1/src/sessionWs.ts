import WsWebSocket from "ws";

export type SessionEvent = Record<string, any>;

export type SessionEventFilter = "all" | "tool" | "assistant";

export interface SessionSubagentRef {
  toolCallId: string;
  name: string | null;
}

export interface ReadSessionEventsOptions {
  all?: boolean;
  watch?: boolean;
  filter?: SessionEventFilter;
  mainStream?: boolean;
  recentLimit?: number;
  onEvent?: (event: SessionEvent) => void;
  backfillTimeoutMs?: number;
  headers?: Record<string, string>;
}

function eventSequence(event: SessionEvent): number {
  const sequence = Number(event.sequence);
  return Number.isFinite(sequence) ? sequence : 0;
}

function eventTimestamp(event: SessionEvent): string {
  const value = typeof event.createdAt === "string" ? event.createdAt : typeof event.timestamp === "string" ? event.timestamp : "";
  return Number.isFinite(Date.parse(value)) ? value : "";
}

function eventKey(event: SessionEvent): string {
  if (typeof event.id === "string" && event.id.length > 0) return `id:${event.id}`;
  const message = runtimeMessage(event);
  if (typeof message?.id === "string" && message.id.length > 0) return `message:${message.id}`;
  return `fallback:${eventSequence(event)}:${eventTimestamp(event)}:${String(event.type ?? "")}`;
}

function compareEvents(a: SessionEvent, b: SessionEvent): number {
  const aTime = eventTimestamp(a);
  const bTime = eventTimestamp(b);
  if (aTime && bTime && aTime !== bTime) return aTime.localeCompare(bTime);
  const sequence = eventSequence(a) - eventSequence(b);
  if (sequence !== 0) return sequence;
  return eventKey(a).localeCompare(eventKey(b));
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

function runtimeEvent(event: SessionEvent): Record<string, any> | null {
  return objectValue(event);
}

function runtimePayload(event: SessionEvent): Record<string, any> {
  return objectValue(event.payload) ?? {};
}

function runtimeMessage(event: SessionEvent): Record<string, any> | null {
  return objectValue(runtimePayload(event).message);
}

function messageContent(event: SessionEvent): any[] {
  const content = runtimeMessage(event)?.content;
  return Array.isArray(content) ? content : [];
}

function toolCallInputName(input: unknown): string | null {
  const value = objectValue(input);
  if (!value) return null;
  const name = value.subagentName ?? value.subagent_type ?? value.subagentType;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

export function sessionEventParentToolCallId(event: SessionEvent): string | null {
  const value = runtimeMessage(event)?.parentToolCallId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function findSessionSubagents(events: SessionEvent[]): SessionSubagentRef[] {
  return events.flatMap((event) =>
    messageContent(event)
      .filter((part: any) => part?.type === "tool_call" && part.toolCall?.name === "agent")
      .map((part: any) => {
        const toolCall = objectValue(part.toolCall) ?? {};
        const toolCallId = typeof toolCall.id === "string" ? toolCall.id : "";
        if (!toolCallId) return null;
        return { toolCallId, name: toolCallInputName(toolCall.input) };
      })
      .filter((item: SessionSubagentRef | null): item is SessionSubagentRef => item !== null),
  );
}

export function findMatchingSessionSubagents(events: SessionEvent[], selector: string): SessionSubagentRef[] {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) return [];
  return findSessionSubagents(events).filter((subagent) => subagent.toolCallId === normalizedSelector || subagent.name === normalizedSelector);
}

function sessionEventToolCallIds(event: SessionEvent): string[] {
  return messageContent(event)
    .filter((part: any) => part?.type === "tool_call")
    .map((part: any) => part.toolCall?.id)
    .filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
}

function sessionEventAgentToolCallIds(event: SessionEvent): string[] {
  return messageContent(event)
    .filter((part: any) => part?.type === "tool_call" && part.toolCall?.name === "agent")
    .map((part: any) => part.toolCall?.id)
    .filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
}

function hasUnresolvedParentToolCall(events: SessionEvent[]): boolean {
  const toolCallIds = new Set(events.flatMap(sessionEventToolCallIds));
  return events.some((event) => {
    const parentToolCallId = sessionEventParentToolCallId(event);
    return parentToolCallId !== null && !toolCallIds.has(parentToolCallId);
  });
}

function hasRootAgentToolResult(event: SessionEvent, parentToolCallId: string, rootAgentToolCallIds: Set<string>): boolean {
  if (!rootAgentToolCallIds.has(parentToolCallId)) return false;
  return messageContent(event).some((part: any) => part?.type === "tool_result" && part.toolCallId === parentToolCallId);
}

export function createMainSessionEventFilter(): (event: SessionEvent) => boolean {
  const rootAgentToolCallIds = new Set<string>();
  const descendantToolCallIds = new Set<string>();

  return (event: SessionEvent): boolean => {
    const parentToolCallId = sessionEventParentToolCallId(event);
    const isSubagentChild = parentToolCallId !== null && descendantToolCallIds.has(parentToolCallId);

    for (const toolCallId of sessionEventToolCallIds(event)) {
      if (isSubagentChild) descendantToolCallIds.add(toolCallId);
    }

    for (const toolCallId of sessionEventAgentToolCallIds(event)) {
      descendantToolCallIds.add(toolCallId);
      if (!isSubagentChild) rootAgentToolCallIds.add(toolCallId);
    }

    if (!isSubagentChild) return true;
    return parentToolCallId !== null && hasRootAgentToolResult(event, parentToolCallId, rootAgentToolCallIds);
  };
}

export function filterSessionEventsBySubagent(events: SessionEvent[], selector: string): SessionEvent[] {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) return [];

  const matches = findMatchingSessionSubagents(events, normalizedSelector);
  const descendantToolCallIds = new Set(matches.map((subagent) => subagent.toolCallId));
  return events.filter((event) => {
    const parentToolCallId = sessionEventParentToolCallId(event);
    if (parentToolCallId === null || !descendantToolCallIds.has(parentToolCallId)) return false;
    for (const toolCallId of sessionEventToolCallIds(event)) descendantToolCallIds.add(toolCallId);
    return true;
  });
}

function isToolEvent(event: SessionEvent): boolean {
  const type = String(runtimeEvent(event)?.type ?? "");
  if (type !== "message.started" && type !== "message.updated" && type !== "message.completed") return false;
  return messageContent(event).some((part) => part?.type === "tool_call" || part?.type === "tool_result");
}

function eventText(event: SessionEvent): string {
  return messageContentText(runtimeMessage(event)?.content);
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

export function isAssistantEvent(event: SessionEvent): boolean {
  const role = runtimeMessage(event)?.role;
  if (role !== "assistant" && role !== "agent") return false;
  return eventText(event).trim().length > 0;
}

export function sessionEventText(event: SessionEvent): string {
  return eventText(event);
}

export function matchesSessionEventFilter(event: SessionEvent, filter: SessionEventFilter = "all"): boolean {
  if (filter === "tool") return isToolEvent(event);
  if (filter === "assistant") return isAssistantEvent(event);
  return true;
}

function websocketConstructor(): any {
  const globalWebSocket = (globalThis as any).WebSocket;
  if (typeof globalWebSocket === "function" && globalWebSocket.name !== "WebSocket") return globalWebSocket;
  return WsWebSocket;
}

function connect(url: string, headers?: Record<string, string>): { ws: any; abort: () => void } {
  const WebSocketCtor = websocketConstructor();
  if (!WebSocketCtor) throw new Error("WebSocket is not available in this Node runtime");
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  try {
    return {
      ws: new WebSocketCtor(url, [], { ...(controller ? { signal: controller.signal } : {}), ...(headers ? { headers } : {}) }),
      abort: () => controller?.abort(),
    };
  } catch {
    return { ws: new WebSocketCtor(url, headers ? { headers } : undefined), abort: () => controller?.abort() };
  }
}

export async function readSessionEvents(url: string, options: ReadSessionEventsOptions = {}): Promise<SessionEvent[]> {
  const filter = options.filter ?? "all";
  const seen = new Set<string>();
  const events: SessionEvent[] = [];
  const recentLimit = options.recentLimit ?? 20;
  const backfillLimit = options.all || options.mainStream ? 200 : recentLimit;
  let includeMainEvent = options.mainStream ? createMainSessionEventFilter() : null;

  const mainStreamEvents = (rawEvents: SessionEvent[]): SessionEvent[] => {
    const include = createMainSessionEventFilter();
    return [...rawEvents].sort(compareEvents).filter((event) => include(event) && matchesSessionEventFilter(event, filter));
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let initialBackfillComplete = false;
    let backfillSeq = 0;
    const connection = connect(url, options.headers);
    const { ws } = connection;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const closeSocket = () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (typeof ws.terminate === "function") ws.terminate();
        else ws.close();
        connection.abort();
      } catch {
        // The promise has already settled; there is nothing useful to report.
      }
    };

    const armTimeout = () => {
      if (options.watch) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        fail(new Error("Session WebSocket backfill timed out"));
      }, options.backfillTimeoutMs ?? 30_000);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSocket();
      reject(error);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      closeSocket();
      const result = options.mainStream ? mainStreamEvents(events) : events.sort(compareEvents);
      if (!options.all && result.length > recentLimit) {
        result.splice(0, result.length - recentLimit);
      }
      if (!options.watch) {
        for (const event of result) options.onEvent?.(event);
      }
      resolve(result);
    };

    const acceptFiltered = (event: SessionEvent) => {
      if (includeMainEvent && !includeMainEvent(event)) return;
      if (!matchesSessionEventFilter(event, filter)) return;
      events.push(event);
      if (options.watch) options.onEvent?.(event);
    };

    const accept = (event: SessionEvent) => {
      const key = eventKey(event);
      if (seen.has(key)) return;
      seen.add(key);
      if (options.mainStream && !initialBackfillComplete) {
        events.push(event);
        return;
      }
      acceptFiltered(event);
    };

    const sendBackfill = (params: { cursor?: number } = {}) => {
      const requestId = `backfill-${++backfillSeq}`;
      ws.send(JSON.stringify({ type: "backfill", requestId, limit: backfillLimit, ...params }));
    };

    ws.onopen = () => {
      sendBackfill();
      armTimeout();
    };

    ws.onerror = (event: any) => {
      if (!settled) {
        const detail = typeof event?.message === "string" ? `: ${event.message}` : "";
        fail(new Error(`Session WebSocket failed${detail}`));
      }
    };

    ws.onclose = () => {
      if (!settled) finish();
    };

    ws.onmessage = (message: any) => {
      const raw = typeof message.data === "string" ? message.data : "";
      let frame: any;
      try {
        frame = raw ? JSON.parse(raw) : null;
      } catch (error) {
        if (error instanceof Error) fail(error);
        else fail(new Error(String(error)));
        return;
      }
      if (frame?.type === "error" && typeof frame.message === "string") {
        fail(new Error(frame.message));
        return;
      }
      if (frame?.type === "runner_unavailable" && typeof frame.message === "string") {
        fail(new Error(frame.message));
        return;
      }
      if (frame?.type === "backfill" && Array.isArray(frame.events)) {
        armTimeout();
        const page = options.all ? frame.events : [...frame.events].reverse();
        for (const event of page) accept(event);
        const needsMoreMainEvents =
          options.mainStream && !options.all && (mainStreamEvents(events).length < recentLimit || hasUnresolvedParentToolCall(events));
        if ((options.all || needsMoreMainEvents) && frame.hasMore && typeof frame.nextCursor === "number") {
          sendBackfill({ cursor: frame.nextCursor });
          return;
        }
        initialBackfillComplete = true;
        if (options.mainStream && options.watch) {
          const rawEvents = events.splice(0, events.length);
          includeMainEvent = createMainSessionEventFilter();
          for (const event of rawEvents.sort(compareEvents)) acceptFiltered(event);
        }
        if (!options.watch) finish();
        return;
      }

      if (frame?.type === "event" && frame.record) {
        if (!initialBackfillComplete && !options.watch) return;
        accept(frame.record);
      }
    };
  });
}
