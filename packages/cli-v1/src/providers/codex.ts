import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BashArgs, ReadArgs } from "@agent-kanban/shared";
import { ToolName } from "@agent-kanban/shared";
import type { ThreadEvent } from "@openai/codex-sdk";
import { resolveExecutable } from "../executable.js";
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
    return await import("@openai/codex-sdk");
  } catch {
    throw new Error("@openai/codex-sdk is not installed; provider features need it on this host");
  }
}

const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const CODEX_MODELS_CACHE_PATH = join(homedir(), ".codex", "models_cache.json");
const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";

function readAccessToken(): string | null {
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    return auth.tokens?.access_token || auth.access_token || null;
  } catch {
    return null;
  }
}

function readSystemPrompt(filePath?: string): string {
  if (!filePath) return "";
  return readFileSync(filePath, "utf-8");
}

function buildPrompt(opts: ExecuteOpts): string {
  return [readSystemPrompt(opts.systemPromptFile), opts.taskContext].filter(Boolean).join("\n\n");
}

/** Per 1M tokens, OpenAI pricing */
const CODEX_PRICING: Record<string, { input: number; cached_input: number; output: number }> = {
  o3: { input: 2.0, cached_input: 0.5, output: 8.0 },
  "o4-mini": { input: 1.1, cached_input: 0.275, output: 4.4 },
  "gpt-4.1": { input: 2.0, cached_input: 0.5, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, cached_input: 0.1, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, cached_input: 0.025, output: 0.4 },
  "codex-mini-latest": { input: 1.5, cached_input: 0.375, output: 6.0 },
};

const RESET_RE = /try again at (.+)/i;
const QUOTA_RE = /quota exceeded|usage limit/i;
function parseRateLimitReset(msg: string): string | null {
  const match = RESET_RE.exec(msg);
  if (!match) {
    return QUOTA_RE.test(msg) ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : null;
  }
  const cleaned = match[1].replace(/(\d+)(st|nd|rd|th)/g, "$1").replace(/\.$/, "");
  const ms = Date.parse(cleaned);
  return Number.isNaN(ms) ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : new Date(ms).toISOString();
}

function calcCost(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number {
  const price = CODEX_PRICING[model] ?? CODEX_PRICING.o3;
  return (inputTokens * price.input + cachedInputTokens * price.cached_input + outputTokens * price.output) / 1_000_000;
}

function resolveCodexPath(): string | undefined {
  return resolveExecutable("codex") ?? undefined;
}

function resolveCodexModel(opts: ExecuteOpts): string | undefined {
  if (!opts.model) {
    return readAccessToken() ? undefined : "o3";
  }
  if (readAccessToken() && !opts.env.OPENAI_API_KEY) {
    // ChatGPT-backed Codex accounts reject explicit model overrides like "o3".
    // Let the CLI choose the account-compatible default model.
    return undefined;
  }
  return opts.model;
}

type CodexCachedModel = {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  context_window?: number;
  max_context_window?: number;
  supported_reasoning_levels?: { effort: string }[];
  default_reasoning_level?: string;
  support_verbosity?: boolean;
};

function readCodexModelCache(): CodexCachedModel[] {
  if (!existsSync(CODEX_MODELS_CACHE_PATH)) throw new Error("Codex models cache not found; start Codex CLI once to populate it");
  const data = JSON.parse(readFileSync(CODEX_MODELS_CACHE_PATH, "utf-8")) as { models?: CodexCachedModel[] };
  return data.models ?? [];
}

function normalizeCodexCachedModel(model: CodexCachedModel): RuntimeModel {
  return {
    id: model.slug,
    name: model.display_name,
    description: model.description,
    context_window: model.context_window,
    supports: {
      verbosity: model.support_verbosity ?? false,
    },
    supported_reasoning_efforts: model.supported_reasoning_levels?.map((level) => level.effort),
    default_reasoning_effort: model.default_reasoning_level,
  };
}

/** Map a single Codex thread event to an AgentEvent (or null to skip). */
export function mapThreadEvent(event: ThreadEvent, model = "o3"): AgentEvent | null {
  switch (event.type) {
    case "item.completed": {
      const item = event.item;
      if (item.type === "agent_message" && item.text) {
        return { type: "message", blocks: [{ type: "text", text: item.text }] };
      }
      if (item.type === "command_execution") {
        return {
          type: "message",
          blocks: [{ type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: ToolName.Bash, input: { command: item.command } }],
        };
      }
      if (item.type === "file_change") {
        const files = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
        return { type: "message", blocks: [{ type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: ToolName.Edit, input: { files } }] };
      }
      if (item.type === "reasoning" && item.text) {
        return { type: "message", blocks: [{ type: "thinking", text: item.text }] };
      }
      return null;
    }

    case "turn.completed": {
      const { input_tokens, cached_input_tokens, output_tokens } = event.usage;
      const cost = calcCost(model, input_tokens ?? 0, cached_input_tokens ?? 0, output_tokens ?? 0);
      return {
        type: "turn.end",
        cost,
        usage: {
          input_tokens: input_tokens ?? 0,
          output_tokens: output_tokens ?? 0,
          cache_read_input_tokens: cached_input_tokens ?? 0,
          cache_creation_input_tokens: 0,
        },
      };
    }

    case "turn.failed": {
      const msg = String(event.error?.message || JSON.stringify(event));
      const resetAt = parseRateLimitReset(msg);
      if (resetAt) return { type: "turn.rate_limit", status: "rejected", resetAt };
      return { type: "turn.error", detail: msg };
    }

    case "error": {
      const detail = String(event.message || JSON.stringify(event));
      const resetAt = parseRateLimitReset(detail);
      if (resetAt) return { type: "turn.rate_limit", status: "rejected", resetAt };
      return { type: "turn.error", detail };
    }

    default:
      return null;
  }
}

/** Map a Codex ThreadItem to a ContentBlock. */
function mapItemToBlock(item: { id?: string; type: string; [k: string]: any }): ContentBlock | null {
  switch (item.type) {
    case "agent_message":
      return item.text ? { type: "text", text: item.text } : null;
    case "command_execution":
      return { type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: ToolName.Bash, input: { command: item.command } };
    case "file_change": {
      const files = item.changes?.map((c: any) => `${c.kind} ${c.path}`).join(", ") ?? "";
      return { type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: ToolName.Edit, input: { files } };
    }
    case "mcp_tool_call":
      return { type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: item.name ?? "mcp_tool", input: item.arguments ?? {} };
    case "web_search":
      return { type: "tool_use", id: item.id ?? `codex-${Date.now()}`, name: ToolName.WebSearch, input: { query: item.query ?? "" } };
    case "reasoning":
      return item.text ? { type: "thinking", text: item.text } : null;
    default:
      return null;
  }
}

/**
 * Streaming mapper for Codex: uses native turn/item lifecycle events.
 * - turn.started → turn.start
 * - item.started → block.start (tool shows loading)
 * - item.completed → block.done (result fills in)
 * - turn.completed → turn.end { cost }
 * - turn.failed/error → turn.error / turn.rate_limit
 */
export function* mapThreadEventStream(event: ThreadEvent, model: string, turnOpen: { value: boolean }): Generator<AgentEvent> {
  if (event.type === "turn.started") {
    if (!turnOpen.value) {
      yield { type: "turn.start" };
      turnOpen.value = true;
    }
    return;
  }

  if (event.type === "item.started") {
    if (!turnOpen.value) {
      yield { type: "turn.start" };
      turnOpen.value = true;
    }
    const block = mapItemToBlock(event.item);
    if (block) yield { type: "block.start", block };
    return;
  }

  if (event.type === "item.completed") {
    if (!turnOpen.value) {
      yield { type: "turn.start" };
      turnOpen.value = true;
    }
    const block = mapItemToBlock(event.item);
    if (block) yield { type: "block.done", block };
    return;
  }

  if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "error") {
    turnOpen.value = false;
    const mapped = mapThreadEvent(event, model);
    if (mapped) yield mapped;
    return;
  }
}

export const codexProvider: AgentProvider = {
  name: "codex",
  label: "Codex CLI",

  async checkAvailability() {
    const token = readAccessToken();
    if (!token && !process.env.OPENAI_API_KEY) return { status: "unauthorized" as const, detail: "Codex is not logged in" };
    if (!token) return { status: "ready" as const };
    try {
      return availabilityFromUsage(await this.fetchUsage!());
    } catch (err) {
      return availabilityFromUsageError(err, "Codex");
    }
  },

  async listModels(): Promise<RuntimeModel[]> {
    return readCodexModelCache()
      .filter((model) => model.visibility !== "hide")
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map(normalizeCodexCachedModel);
  },

  async execute(opts: ExecuteOpts): Promise<AgentHandle> {
    const model = resolveCodexModel(opts) ?? "o3";
    let resumeToken: string | undefined = opts.resumeToken;

    const { Codex } = await sdk();
    const codex = new Codex({ env: opts.env, codexPathOverride: resolveCodexPath() });
    const threadOpts = {
      model: resolveCodexModel(opts),
      workingDirectory: opts.cwd,
      sandboxMode: "danger-full-access" as const,
      approvalPolicy: "never" as const,
    };
    const thread = opts.resume ? codex.resumeThread(opts.resumeToken ?? opts.sessionId, threadOpts) : codex.startThread(threadOpts);

    const abortController = new AbortController();
    const streamed = await thread.runStreamed(buildPrompt(opts), { signal: abortController.signal });

    const events = (async function* () {
      const turnOpen = { value: false };
      for await (const event of streamed.events) {
        if (event.type === "thread.started") resumeToken = event.thread_id;
        yield* mapThreadEventStream(event, model, turnOpen);
      }
    })();

    let aborted = false;
    return {
      events,
      async abort() {
        if (aborted) return;
        aborted = true;
        abortController.abort();
      },
      async send() {
        throw new Error("Codex multi-turn send not implemented");
      },
      getResumeToken() {
        return resumeToken;
      },
    };
  },

  async fetchUsage(): Promise<UsageInfo | null> {
    const token = readAccessToken();
    if (!token) return null;

    let res: Response;
    try {
      res = await fetch(USAGE_API, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new UsageFetchError(`codex usage request failed: ${(err as Error).message}`, { cause: err });
    }

    if (!res.ok) {
      throw new UsageFetchError(`codex usage API returned ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
      });
    }

    type RateLimitWindow = { used_percent: number; reset_at: number; limit_window_seconds: number };
    const data = (await res.json()) as { rate_limit?: { primary_window?: RateLimitWindow; secondary_window?: RateLimitWindow } };
    const rl = data.rate_limit;
    const windowLabel = (secs: number) => (secs <= 18000 ? "5-Hour" : "Weekly");
    const windows: UsageWindow[] = [];
    if (rl?.primary_window) {
      windows.push({
        runtime: "codex",
        label: windowLabel(rl.primary_window.limit_window_seconds),
        utilization: rl.primary_window.used_percent,
        resets_at: new Date(rl.primary_window.reset_at * 1000).toISOString(),
      });
    }
    if (rl?.secondary_window) {
      windows.push({
        runtime: "codex",
        label: windowLabel(rl.secondary_window.limit_window_seconds),
        utilization: rl.secondary_window.used_percent,
        resets_at: new Date(rl.secondary_window.reset_at * 1000).toISOString(),
      });
    }
    return { windows, updated_at: new Date().toISOString() };
  },

  async getHistory(_sessionId, resumeToken) {
    if (!resumeToken) return [];
    return readCodexJsonl(resumeToken);
  },
};

// ── History from local JSONL ──

function findSessionFile(threadId: string): string | null {
  const suffix = `${threadId}.jsonl`;
  try {
    for (const year of readdirSync(CODEX_SESSIONS_DIR)) {
      const yearDir = join(CODEX_SESSIONS_DIR, year);
      for (const month of readdirSync(yearDir)) {
        const monthDir = join(yearDir, month);
        for (const day of readdirSync(monthDir)) {
          const dayDir = join(monthDir, day);
          for (const file of readdirSync(dayDir)) {
            if (file.endsWith(suffix)) return join(dayDir, file);
          }
        }
      }
    }
  } catch {
    /* dir missing */
  }
  return null;
}

/**
 * Normalize a JSONL function_call to the same name/input shape as live
 * streaming (`mapItemToBlock`). This ensures the frontend renders history
 * and live events identically.
 */
/**
 * Normalize a JSONL function_call to the canonical tool names the frontend
 * recognizes (Bash, Edit, Read, WebSearch, etc.), matching live streaming output.
 */
function normalizeFunctionCall(name: string, rawArgs: Record<string, unknown>): { name: string; input: Record<string, unknown> } | null {
  switch (name) {
    case "exec_command": {
      const args: BashArgs = { command: String(rawArgs.cmd ?? "") };
      return { name: ToolName.Bash, input: args };
    }
    case "shell": {
      const cmd = Array.isArray(rawArgs.command) ? rawArgs.command.join(" ") : String(rawArgs.command ?? "");
      const args: BashArgs = { command: cmd };
      return { name: ToolName.Bash, input: args };
    }
    case "shell_command": {
      const args: BashArgs = { command: String(rawArgs.command ?? "") };
      return { name: ToolName.Bash, input: args };
    }
    case "write_stdin": {
      // write_stdin with empty chars is a poll for command output — skip it
      const chars = String(rawArgs.chars ?? "");
      if (!chars) return null;
      const args: BashArgs = { command: chars };
      return { name: ToolName.Bash, input: args };
    }

    // Image viewing → Read (closest frontend equivalent)
    case "view_image": {
      const args: ReadArgs = { filePath: String(rawArgs.path ?? "") };
      return { name: ToolName.Read, input: args };
    }

    // User interaction → AskUserQuestion
    case "request_user_input":
      return { name: ToolName.AskUserQuestion, input: rawArgs };

    // Internal planner — no specific UI, keep original name for fallback
    case "update_plan":
    case "list_mcp_resources":
    case "read_mcp_resource":
      return { name, input: rawArgs };

    default:
      return { name, input: rawArgs };
  }
}

function mapResponseItem(payload: Record<string, any>): AgentEvent | null {
  switch (payload.type) {
    case "message": {
      if (payload.role === "assistant") {
        const texts = (payload.content ?? []).filter((c: any) => c.type === "output_text" && c.text).map((c: any) => c.text);
        if (texts.length > 0) {
          return { type: "message", blocks: [{ type: "text", text: texts.join("\n") }] };
        }
      }
      if (payload.role === "user") {
        const texts = (payload.content ?? []).filter((c: any) => c.type === "input_text" && c.text).map((c: any) => c.text);
        if (texts.length > 0) return { type: "message.user", text: texts.join("\n") };
      }
      return null;
    }
    case "function_call": {
      let rawArgs: Record<string, unknown> = {};
      if (payload.arguments) {
        try {
          rawArgs = JSON.parse(payload.arguments);
        } catch {
          rawArgs = { raw: payload.arguments };
        }
      }
      const normalized = normalizeFunctionCall(payload.name ?? "tool", rawArgs);
      if (!normalized) return null;
      return {
        type: "message",
        blocks: [{ type: "tool_use", id: payload.call_id ?? `codex-hist-${Date.now()}`, name: normalized.name, input: normalized.input }],
      };
    }
    case "function_call_output":
      return {
        type: "message",
        blocks: [{ type: "tool_result", tool_use_id: payload.call_id ?? "", output: payload.output }],
      };
    default:
      return null;
  }
}

/** @internal Exported for tests only. */
export function readCodexJsonl(threadId: string): HistoryEvent[] {
  const file = findSessionFile(threadId);
  if (!file) return [];

  const lines = readFileSync(file, "utf-8").split("\n");
  const events: HistoryEvent[] = [];
  let counter = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "response_item") continue;
    // Skip developer/system messages
    if (row.payload?.role === "developer") continue;

    const event = mapResponseItem(row.payload);
    if (event) {
      events.push({
        id: `codex-hist-${++counter}`,
        event,
        timestamp: row.timestamp ?? new Date().toISOString(),
      });
    }
  }
  return events;
}
