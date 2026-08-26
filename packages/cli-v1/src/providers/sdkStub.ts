// Build-time stand-in for the provider runtime SDKs in the standalone CLI
// bundle (dist/standalone.js). Cloud sandbox sessions only use the API-client
// commands; any code path that actually spawns a local provider fails fast.

function unavailable(name: string): never {
  throw new Error(`${name} is not available in the standalone ak bundle (local provider runtimes are excluded)`);
}

// @anthropic-ai/claude-agent-sdk
export function query(): never {
  unavailable("claude-agent-sdk query");
}
export function getSessionMessages(): never {
  unavailable("claude-agent-sdk getSessionMessages");
}

// @openai/codex-sdk
export class Codex {
  constructor() {
    unavailable("codex-sdk Codex");
  }
}

// @github/copilot-sdk
export class CopilotClient {
  constructor() {
    unavailable("copilot-sdk CopilotClient");
  }
}
export function approveAll(): never {
  unavailable("copilot-sdk approveAll");
}

// @agentclientprotocol/sdk
export class ClientSideConnection {
  constructor() {
    unavailable("acp-sdk ClientSideConnection");
  }
}
export function ndJsonStream(): never {
  unavailable("acp-sdk ndJsonStream");
}
export const PROTOCOL_VERSION = 0;
