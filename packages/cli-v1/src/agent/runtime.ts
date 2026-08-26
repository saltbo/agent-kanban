import { execFileSync } from "node:child_process";
import type { LeaderAgentRuntime } from "@agent-kanban/shared";
import { getWindowsProcessAncestry } from "./windowsProcessTree.js";

interface RuntimeSpec {
  commandPattern: RegExp;
}

const RUNTIMES: Record<LeaderAgentRuntime, RuntimeSpec> = {
  claude: { commandPattern: /(^|[\\/])claude(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@anthropic-ai[\\/]claude-code[\\/]/i },
  codex: { commandPattern: /(^|[\\/])codex(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@openai[\\/]codex[\\/]/i },
  gemini: { commandPattern: /(^|[\\/])gemini(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@google[\\/]gemini-cli[\\/]/i },
  copilot: { commandPattern: /(^|[\\/])copilot(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@github[\\/]copilot[\\/]/i },
  hermes: {
    commandPattern: /(^|[\\/])hermes(?:\.exe|\.cmd)?(?=["\s]|$)|(^|\s)hermes_cli\.main(\s|$)/i,
  },
  antigravity: { commandPattern: /(^|[\\/])agy(?:\.exe|\.cmd)?(?=["\s]|$)/i },
  opencode: { commandPattern: /(^|[\\/])opencode(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]opencode-ai[\\/]opencode[\\/]/i },
  cursor: { commandPattern: /(^|[\\/])cursor-agent(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@cursor[\\/].*cursor-agent/i },
  qwen: { commandPattern: /(^|[\\/])qwen(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@qwen-code[\\/]qwen-code[\\/]/i },
  goose: { commandPattern: /(^|[\\/])goose(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]aaif-goose[\\/]goose[\\/]/i },
  amp: { commandPattern: /(^|[\\/])amp(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]@ampcode[\\/]cli[\\/]/i },
  kiro: { commandPattern: /(^|[\\/])kiro-cli(?:\.exe|\.cmd|\.appimage)?(?=["\s]|$)/i },
  pi: { commandPattern: /(^|[\\/])pi(?:\.exe|\.cmd)?(?=["\s]|$)|[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js/i },
};

function hasEnvironmentVariable(name: string): boolean {
  return process.env[name] !== undefined;
}

const ENVIRONMENT_DETECTORS: readonly [LeaderAgentRuntime, () => boolean][] = [
  ["antigravity", () => hasEnvironmentVariable("ANTIGRAVITY_AGENT")],
  ["opencode", () => hasEnvironmentVariable("OPENCODE")],
  ["amp", () => process.env.AGENT === "amp"],
  ["goose", () => process.env.AGENT === "goose" || hasEnvironmentVariable("GOOSE_TERMINAL")],
  ["qwen", () => hasEnvironmentVariable("QWEN_CODE")],
  ["cursor", () => hasEnvironmentVariable("CURSOR_AGENT")],
  ["kiro", () => hasEnvironmentVariable("AGENT_DISPLAY_OUT") && hasEnvironmentVariable("AGENT_CONTEXT_OUT")],
  ["pi", () => hasEnvironmentVariable("PI_CODING_AGENT")],
  ["codex", () => hasEnvironmentVariable("CODEX_CI")],
  ["copilot", () => hasEnvironmentVariable("COPILOT_CLI")],
  ["gemini", () => hasEnvironmentVariable("GEMINI_CLI")],
  ["claude", () => hasEnvironmentVariable("CLAUDECODE")],
  ["hermes", () => hasEnvironmentVariable("HERMES_INTERACTIVE") || hasEnvironmentVariable("HERMES_SESSION_KEY")],
];

export function detectRuntime(): LeaderAgentRuntime | null {
  for (const [runtime, matches] of ENVIRONMENT_DETECTORS) {
    if (matches()) return runtime;
  }
  return null;
}

function readProcess(pid: number): { ppid: number; command: string } | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "ppid=,command="], { encoding: "utf-8" }).trim();
    if (!out) return null;
    const match = out.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) return null;
    return { ppid: Number(match[1]), command: match[2] };
  } catch {
    return null;
  }
}

/**
 * Walk up the process ancestry from `ak` to find the long-lived agent runtime
 * process that ultimately invoked us. Returns its PID, or
 * null if no matching ancestor is found.
 *
 * Used only after environment-based runtime detection to anchor leader sessions
 * to a stable, long-lived PID instead of the
 * ephemeral shell that spawned `ak` (which dies in milliseconds and causes the
 * daemon to immediately reap the session).
 */
export function findRuntimeAncestorPid(runtime: string): number | null {
  const pattern = RUNTIMES[runtime as LeaderAgentRuntime]?.commandPattern;
  if (!pattern) return null;
  if (process.platform === "win32") {
    for (const info of getWindowsProcessAncestry(process.ppid)) {
      const command = info.commandLine || info.executable || "";
      if (pattern.test(command)) return info.pid;
    }
    return null;
  }
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    const info = readProcess(pid);
    if (!info) return null;
    if (pattern.test(info.command)) return pid;
    pid = info.ppid;
  }
  return null;
}
