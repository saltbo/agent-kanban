import { spawn } from "node:child_process";
import { ApiClient, ApiError } from "./base.js";

const RESOURCE_SERVER = process.env.AK_REALMROOT_RESOURCE_SERVER || "agent-kanban";

export class AgentClient extends ApiClient {
  constructor(
    baseUrl: string,
    private readonly agentId: string,
    private readonly sessionId: string,
    ..._legacyKey: unknown[]
  ) {
    super(baseUrl);
  }

  static async fromEnv(): Promise<AgentClient | null> {
    const apiUrl = process.env.AK_API_URL;
    const agentId = process.env.AK_AGENT_ID;
    if (!apiUrl || !agentId || !process.env.REALMROOT_STATE_DIR) return null;
    return new AgentClient(apiUrl, agentId, process.env.AK_SESSION_ID || process.env.AMA_SESSION_ID || "");
  }

  protected async authorizationHeaders(): Promise<Record<string, string>> {
    throw new Error("Agent HTTP authority is provided by Realmroot Toolbox");
  }

  protected override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const target = `${RESOURCE_SERVER}/${path.replace(/^\/api\/?/, "")}`;
    const args = ["--json", "toolbox", method.toLowerCase(), target, "--output", "json"];
    if (body !== undefined) args.push("--content-type", "application/json");
    if (this.sessionId) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(this.sessionId)) throw new Error("AK_SESSION_ID is invalid");
      args.push("--header", `X-AK-Session-ID: ${this.sessionId}`);
    }
    const result = await runRealmroot(args, body === undefined ? undefined : JSON.stringify(body));
    if (result.code !== 0) throw new ApiError(502, result.stderr.trim() || "Realmroot Toolbox request failed", "REALMROOT_TOOLBOX_FAILED");
    if (!result.stdout.trim()) return undefined as T;
    return JSON.parse(result.stdout) as T;
  }

  getAgentId(): string {
    return this.agentId;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}

function runRealmroot(args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("realmroot", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
