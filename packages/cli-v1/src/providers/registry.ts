import { type AgentRuntime, normalizeRuntime } from "@agent-kanban/shared";
import { resolveExecutable } from "../executable.js";
import { type AcpRuntimeConfig, createAcpProvider } from "./acp.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { copilotProvider } from "./copilot.js";
import { geminiProvider } from "./gemini.js";
import type { AgentProvider } from "./types.js";

export { normalizeRuntime };

const providers = new Map<AgentRuntime, AgentProvider>();

/**
 * ACP-based runtimes. Adding a new ACP-compliant agent is a one-row entry:
 * the generic `createAcpProvider` handles spawn, protocol, event mapping.
 */
const ACP_RUNTIMES: AcpRuntimeConfig[] = [{ runtime: "hermes", label: "Hermes", command: "hermes", args: ["acp"] }];

/** Binary name used to detect availability per runtime */
const RUNTIME_COMMANDS: Partial<Record<AgentRuntime, string>> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot",
  hermes: "hermes",
  // Cloud-only runtime: no local binary, never detected as a machine runtime.
  ama: "ama-cloud-sandbox",
};

export function registerProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: AgentRuntime): AgentProvider {
  const provider = providers.get(name);
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${[...providers.keys()].join(", ")}`);
  }
  return provider;
}

export function getAvailableProviders(): AgentProvider[] {
  return [...providers.values()].filter((provider) => {
    const command = RUNTIME_COMMANDS[provider.name];
    return command ? resolveExecutable(command) !== null : false;
  });
}

// Auto-register built-in providers
registerProvider(claudeProvider);
registerProvider(geminiProvider);
registerProvider(codexProvider);
registerProvider(copilotProvider);
for (const cfg of ACP_RUNTIMES) {
  registerProvider(createAcpProvider(cfg));
}
