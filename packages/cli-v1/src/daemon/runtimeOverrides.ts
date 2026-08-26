import { type AgentRuntime, normalizeRuntime } from "@agent-kanban/shared";

const KNOWN_RUNTIMES = new Set<AgentRuntime>(["claude", "codex", "gemini", "copilot", "hermes"]);

export function isRuntimeLimitIgnored(runtime: string): boolean {
  const normalized = normalizeRuntime(runtime);
  return KNOWN_RUNTIMES.has(normalized) && ignoredRuntimeLimits().has(normalized);
}

function ignoredRuntimeLimits(): Set<AgentRuntime> {
  const raw = process.env.AK_IGNORE_RUNTIME_LIMITS ?? "";
  const runtimes = raw
    .split(",")
    .map((runtime) => normalizeRuntime(runtime.trim()))
    .filter((runtime): runtime is AgentRuntime => KNOWN_RUNTIMES.has(runtime));
  return new Set(runtimes);
}
