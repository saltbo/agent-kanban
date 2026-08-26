import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BashArgs, type GlobArgs, type GrepArgs, type ReadArgs, ToolName, type WriteArgs } from "@agent-kanban/shared";
import { spawnAgent } from "./spawnHelper.js";
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
import { availabilityFromUsage, availabilityFromUsageError, UsageFetchError } from "./types.js";

const OAUTH_CREDS_PATH = join(homedir(), ".gemini", "oauth_creds.json");
const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");
const GEMINI_MODELS_API = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODELS_PAGE_SIZE = 1000;
const CODE_ASSIST_API = "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CLI_OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_CLI_OAUTH_CLIENT_SECRET = "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";

/** Per 1M tokens, paid tier pricing */
const GEMINI_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-3-flash-preview": { input: 0.5, output: 3.0 },
  "gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.5 },
};

function readSystemPrompt(filePath?: string): string {
  if (!filePath) return "";
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function readGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? null;
}

function readGoogleCloudProject(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
}

type GeminiOAuthCreds = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
};

function readGeminiOAuthCreds(): GeminiOAuthCreds | null {
  try {
    return JSON.parse(readFileSync(OAUTH_CREDS_PATH, "utf-8")) as GeminiOAuthCreds;
  } catch {
    return null;
  }
}

async function refreshGeminiAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GEMINI_CLI_OAUTH_CLIENT_ID,
      client_secret: GEMINI_CLI_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json()) as { access_token?: string };
  if (!res.ok || !data.access_token) throw new UsageFetchError(`gemini oauth token refresh returned ${res.status}`, { status: res.status });
  return data.access_token;
}

async function readGeminiAccessToken(): Promise<string | null> {
  const creds = readGeminiOAuthCreds();
  if (!creds) return null;
  if (creds.access_token && (creds.expiry_date ?? 0) > Date.now() + 60_000) return creds.access_token;
  if (!creds.refresh_token) return null;
  return refreshGeminiAccessToken(creds.refresh_token);
}

function normalizeGeminiModelId(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

type GeminiModel = {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

async function fetchGeminiModelPage(key: string, pageToken?: string): Promise<{ models?: GeminiModel[]; nextPageToken?: string }> {
  const url = new URL(GEMINI_MODELS_API);
  url.searchParams.set("key", key);
  url.searchParams.set("pageSize", String(GEMINI_MODELS_PAGE_SIZE));
  if (pageToken) url.searchParams.set("pageToken", pageToken);

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Gemini models API returned ${res.status}`);
  return (await res.json()) as { models?: GeminiModel[]; nextPageToken?: string };
}

function normalizeGeminiModel(model: GeminiModel): RuntimeModel {
  return {
    id: normalizeGeminiModelId(model.name),
    name: model.displayName,
    description: model.description,
    input_token_limit: model.inputTokenLimit,
    output_token_limit: model.outputTokenLimit,
    supports: {
      generate_content: true,
      stream_generate_content: model.supportedGenerationMethods?.includes("streamGenerateContent") ?? false,
    },
  };
}

type CodeAssistCredit = {
  creditType?: string;
  creditAmount?: string;
};

type CodeAssistQuotaBucket = {
  modelId?: string;
  remainingFraction?: number;
  remainingAmount?: string;
  resetTime?: string;
};

type CodeAssistLoadResponse = {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: { id?: string; name?: string };
  paidTier?: { id?: string; name?: string; availableCredits?: CodeAssistCredit[] };
};

type CodeAssistQuotaResponse = {
  buckets?: CodeAssistQuotaBucket[];
};

async function codeAssistPost<T>(accessToken: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CODE_ASSIST_API}:${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new UsageFetchError(`gemini code assist ${method} returned ${res.status}`, { status: res.status });
  return (await res.json()) as T;
}

function codeAssistProjectId(load: CodeAssistLoadResponse, envProjectId: string | undefined): string | null {
  if (typeof load.cloudaicompanionProject === "string") return load.cloudaicompanionProject;
  return load.cloudaicompanionProject?.id ?? envProjectId ?? null;
}

async function loadCodeAssist(accessToken: string, projectId: string | undefined): Promise<CodeAssistLoadResponse> {
  return codeAssistPost<CodeAssistLoadResponse>(accessToken, "loadCodeAssist", {
    cloudaicompanionProject: projectId,
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
      duetProject: projectId,
    },
  });
}

async function retrieveCodeAssistQuota(): Promise<{ load: CodeAssistLoadResponse; quota: CodeAssistQuotaResponse }> {
  const accessToken = await readGeminiAccessToken();
  if (!accessToken) throw new UsageFetchError("Gemini CLI OAuth credentials not found", { status: 401 });
  const envProjectId = readGoogleCloudProject();
  const load = await loadCodeAssist(accessToken, envProjectId);
  const projectId = codeAssistProjectId(load, envProjectId);
  if (!projectId) throw new UsageFetchError("Gemini Code Assist did not return a project id");
  const quota = await codeAssistPost<CodeAssistQuotaResponse>(accessToken, "retrieveUserQuota", { project: projectId });
  return { load, quota };
}

async function listPublicGeminiModels(key: string): Promise<RuntimeModel[]> {
  const models: GeminiModel[] = [];
  let pageToken: string | undefined;
  do {
    const page = await fetchGeminiModelPage(key, pageToken);
    models.push(...(page.models ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return models.filter((model) => model.supportedGenerationMethods?.includes("generateContent")).map(normalizeGeminiModel);
}

function modelsFromCodeAssistQuota(quota: CodeAssistQuotaResponse): RuntimeModel[] {
  return (quota.buckets ?? [])
    .filter((bucket): bucket is CodeAssistQuotaBucket & { modelId: string } => Boolean(bucket.modelId))
    .map((bucket) => ({
      id: bucket.modelId,
      name: bucket.modelId,
    }));
}

function usageFromCodeAssist(quota: CodeAssistQuotaResponse): UsageInfo {
  const windows: UsageWindow[] = (quota.buckets ?? [])
    .filter(
      (bucket): bucket is CodeAssistQuotaBucket & { modelId: string; remainingFraction: number; resetTime: string } =>
        Boolean(bucket.modelId) && bucket.remainingFraction !== undefined && Boolean(bucket.resetTime),
    )
    .map((bucket) => ({
      runtime: "gemini",
      label: bucket.modelId,
      utilization: Number(((1 - bucket.remainingFraction) * 100).toFixed(2)),
      resets_at: bucket.resetTime,
    }));
  return { windows, updated_at: new Date().toISOString() };
}

function buildPrompt(opts: ExecuteOpts): string {
  return [readSystemPrompt(opts.systemPromptFile), opts.taskContext].filter(Boolean).join("\n\n");
}

export function parseEvent(raw: string): AgentEvent | null {
  const event = parseJsonEvent(raw);
  if (!event) return null;

  if (event.type === "message" && event.role === "assistant") {
    return liveMessageEvent(event);
  }

  if (event.type === "tool_use") {
    const normalized = normalizeGeminiTool(event.tool_name ?? "tool", event.parameters ?? {});
    if (!normalized) return null;
    return {
      type: "message",
      blocks: [
        {
          type: "tool_use",
          id: event.tool_id ?? `${event.tool_name ?? "gemini"}-${event.timestamp ?? "tool"}`,
          name: normalized.name,
          input: normalized.input,
        },
      ],
    };
  }

  if (event.type === "tool_result") {
    return {
      type: "message",
      blocks: [
        {
          type: "tool_result",
          tool_use_id: event.tool_id ?? "",
          output: textFromContent(event.output ?? event.result ?? event.content) || String(event.status ?? "done"),
          error: event.status === "error",
        },
      ],
    };
  }

  if (event.type === "result") {
    let cost = 0;
    if (event.stats?.models) {
      for (const [model, usage] of Object.entries(event.stats.models)) {
        const pricing = GEMINI_PRICING[model];
        if (pricing) {
          const u = usage as { input_tokens: number; output_tokens: number };
          cost += (u.input_tokens * pricing.input + u.output_tokens * pricing.output) / 1_000_000;
        }
      }
    }
    return { type: "turn.end", cost, usage: event.stats };
  }

  if (event.type === "error" || event.status === "error") {
    const source = event.message || event.error;
    const detail = typeof source === "object" ? JSON.stringify(source) : String(source || JSON.stringify(event));
    return { type: "turn.error", detail };
  }

  return null;
}

function liveMessageEvent(event: any): AgentEvent | null {
  const blocks: ContentBlock[] = [];
  if (event.content) blocks.push({ type: "text", text: String(event.content) });

  for (const toolCall of event.toolCalls ?? event.tool_calls ?? []) {
    const normalized = normalizeGeminiTool(toolCall.name ?? toolCall.function?.name ?? "tool", toolCall.args ?? toolCall.function?.arguments ?? {});
    if (!normalized) continue;
    const id = toolCall.id ?? `${event.id ?? "gemini-live"}-tool`;
    blocks.push({ type: "tool_use", id, name: normalized.name, input: normalized.input });
    const result = toolCall.result ?? toolCall.response;
    if (result) blocks.push({ type: "tool_result", tool_use_id: id, output: textFromContent(result) || JSON.stringify(result) });
  }

  return blocks.length > 0 ? { type: "message", blocks } : null;
}

export function parseSessionId(raw: string): string | null {
  const event = parseJsonEvent(raw);
  return typeof event?.session_id === "string" ? event.session_id : null;
}

function parseJsonEvent(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const jsonStart = raw.indexOf("{");
    if (jsonStart === -1) return null;
    return JSON.parse(raw.slice(jsonStart));
  }
}

export function buildArgs(opts: ExecuteOpts): string[] {
  const args = ["--prompt", buildPrompt(opts), "--output-format", "stream-json", "--yolo", "--skip-trust"];
  if (opts.model) {
    args.push("--model", opts.model);
  }
  return args;
}

export function buildResumeArgs(sessionId: string, model?: string, prompt = ""): string[] {
  const args = ["--resume", sessionId, "--prompt", prompt, "--output-format", "stream-json", "--yolo", "--skip-trust"];
  if (model) {
    args.push("--model", model);
  }
  return args;
}

export function resolveGeminiCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.VOLTA_HOME) return "gemini";
  const voltaPackageBin = join(env.VOLTA_HOME, "tools", "image", "packages", "@google", "gemini-cli", "bin", "gemini");
  return existsSync(voltaPackageBin) ? voltaPackageBin : "gemini";
}

function findGeminiSessionFiles(sessionId: string): string[] {
  const shortId = sessionId.slice(0, 8);
  const matches: string[] = [];
  try {
    for (const project of readdirSync(GEMINI_TMP_DIR)) {
      const chatsDir = join(GEMINI_TMP_DIR, project, "chats");
      let files: string[];
      try {
        files = readdirSync(chatsDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(`-${shortId}.jsonl`)) continue;
        const path = join(chatsDir, file);
        if (isGeminiSessionFile(path, sessionId)) matches.push(path);
      }
    }
  } catch {
    return [];
  }
  return matches.sort();
}

function isGeminiSessionFile(path: string, sessionId: string): boolean {
  const firstLine = readFileSync(path, "utf-8").split("\n", 1)[0];
  const header = JSON.parse(firstLine);
  return header.sessionId === sessionId;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
      return "";
    })
    .filter(Boolean)
    .join("");
}

function eventFromRecord(record: any, id: string): AgentEvent | null {
  if (record.type === "user") {
    const text = textFromContent(record.content);
    return text ? { type: "message.user", text } : null;
  }
  if (record.type !== "gemini") return null;

  const blocks: ContentBlock[] = [];
  const text = textFromContent(record.content);
  if (text) blocks.push({ type: "text", text });
  for (const toolCall of record.toolCalls ?? []) {
    const normalized = normalizeGeminiTool(toolCall.name ?? "tool", toolCall.args ?? {});
    if (!normalized) continue;
    blocks.push({ type: "tool_use", id: toolCall.id ?? `${id}-tool`, name: normalized.name, input: normalized.input });
    if (toolCall.result)
      blocks.push({
        type: "tool_result",
        tool_use_id: toolCall.id ?? "",
        output: textFromContent(toolCall.result) || JSON.stringify(toolCall.result),
      });
  }
  return blocks.length > 0 ? { type: "message", blocks } : null;
}

function normalizeGeminiTool(name: string, rawArgs: Record<string, unknown>): { name: string; input: Record<string, unknown> } | null {
  switch (name) {
    case "run_shell_command": {
      const args: BashArgs = {
        command: String(rawArgs.command ?? ""),
        description: rawArgs.description === undefined ? undefined : String(rawArgs.description),
      };
      return { name: ToolName.Bash, input: args };
    }
    case "read_file": {
      const args: ReadArgs = {
        filePath: String(rawArgs.file_path ?? rawArgs.path ?? ""),
        offset: rawArgs.offset as number | undefined,
        limit: rawArgs.limit as number | undefined,
      };
      return { name: ToolName.Read, input: args };
    }
    case "list_directory": {
      const args: ReadArgs = { filePath: String(rawArgs.dir_path ?? rawArgs.path ?? "") };
      return { name: ToolName.Read, input: args };
    }
    case "write_file": {
      const args: WriteArgs = { filePath: String(rawArgs.file_path ?? rawArgs.path ?? ""), content: String(rawArgs.content ?? "") };
      return { name: ToolName.Write, input: args };
    }
    case "glob": {
      const args: GlobArgs = { pattern: String(rawArgs.pattern ?? ""), path: rawArgs.path as string | undefined };
      return { name: ToolName.Glob, input: args };
    }
    case "search_file_content": {
      const args: GrepArgs = { pattern: String(rawArgs.pattern ?? ""), path: rawArgs.path as string | undefined };
      return { name: ToolName.Grep, input: args };
    }
    case "google_web_search":
    case "web_search":
      return { name: ToolName.WebSearch, input: { query: String(rawArgs.query ?? "") } };
    case "activate_skill":
    case "update_topic":
      return null;
    default:
      return { name, input: rawArgs };
  }
}

function readJsonlHistory(file: string): HistoryEvent[] {
  const messages = new Map<string, any>();
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (typeof record.$rewindTo === "string") {
      let deleting = false;
      for (const id of Array.from(messages.keys())) {
        if (id === record.$rewindTo) deleting = true;
        if (deleting) messages.delete(id);
      }
    } else if (typeof record.id === "string") {
      messages.set(record.id, record);
    }
  }
  return historyFromRecords(Array.from(messages.values()));
}

function historyFromRecords(records: any[]): HistoryEvent[] {
  return records.flatMap((record, index) => {
    const id = record.id ?? `gemini-hist-${index + 1}`;
    const event = eventFromRecord(record, id);
    return event ? [{ id, event, timestamp: record.timestamp ?? new Date().toISOString() }] : [];
  });
}

/** @internal Exported for tests only. */
export function readGeminiHistory(sessionId: string): HistoryEvent[] {
  return findGeminiSessionFiles(sessionId).flatMap(readJsonlHistory);
}

export const geminiProvider: AgentProvider = {
  name: "gemini",
  label: "Gemini CLI",

  async checkAvailability() {
    const hasApiKey = Boolean(readGeminiApiKey());
    if (hasApiKey) return { status: "ready" };
    if (!existsSync(OAUTH_CREDS_PATH)) {
      return { status: "unauthorized", detail: "Gemini CLI is not authenticated" };
    }
    try {
      return availabilityFromUsage(await this.fetchUsage!());
    } catch (err) {
      return availabilityFromUsageError(err, "Gemini");
    }
  },

  async listModels(): Promise<RuntimeModel[]> {
    const key = readGeminiApiKey();
    if (key) return listPublicGeminiModels(key);
    const { quota } = await retrieveCodeAssistQuota();
    return modelsFromCodeAssistQuota(quota);
  },

  async fetchUsage(): Promise<UsageInfo | null> {
    if (!existsSync(OAUTH_CREDS_PATH)) return null;
    const { quota } = await retrieveCodeAssistQuota();
    return usageFromCodeAssist(quota);
  },

  async execute(opts: ExecuteOpts): Promise<AgentHandle> {
    if (opts.resume && !opts.resumeToken) throw new Error("gemini: resume requested but no resumeToken provided");

    let resumeToken = opts.resumeToken;
    const args = opts.resume ? buildResumeArgs(opts.resumeToken!, opts.model, opts.taskContext) : buildArgs(opts);
    const handle = spawnAgent({
      command: resolveGeminiCommand(opts.env),
      args,
      cwd: opts.cwd,
      env: opts.env,
      onLine(raw) {
        resumeToken = parseSessionId(raw) ?? resumeToken;
      },
      parseEvent,
    });

    return {
      ...handle,
      getResumeToken() {
        return resumeToken;
      },
    };
  },

  async getHistory(_sessionId, resumeToken): Promise<HistoryEvent[]> {
    if (!resumeToken) return [];
    return readGeminiHistory(resumeToken);
  },
};
