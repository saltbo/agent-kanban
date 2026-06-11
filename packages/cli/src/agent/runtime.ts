import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PID_FILE } from "../paths.js";
import { isPidAlive } from "../session/store.js";

interface RuntimeSpec {
  /** Environment variables set by the runtime when it spawns subprocesses. */
  envVars: string[];
  commandPattern: RegExp;
}

const RUNTIMES: Record<string, RuntimeSpec> = {
  claude: { envVars: ["CLAUDECODE"], commandPattern: /(^|\/)claude(\s|$)/ },
  codex: { envVars: ["CODEX_CI"], commandPattern: /(^|\/)codex(\s|$)/ },
  gemini: { envVars: ["GEMINI_CLI"], commandPattern: /(^|\/)gemini(\s|$)/ },
  copilot: { envVars: ["COPILOT_CLI"], commandPattern: /(^|\/)copilot(\s|$)/ },
  hermes: {
    envVars: ["HERMES_INTERACTIVE", "HERMES_SESSION_KEY"],
    commandPattern: /(^|\/)hermes(\s|$)|(^|\s)hermes_cli\.main(\s|$)/,
  },
};

export function detectRuntime(): string | null {
  for (const [name, { envVars }] of Object.entries(RUNTIMES)) {
    if (envVars.some((envVar) => process.env[envVar])) return name;
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
 * process (claude/codex/gemini) that ultimately invoked us. Returns its PID, or
 * null if no matching ancestor is found.
 *
 * Used to anchor leader sessions to a stable, long-lived PID instead of the
 * ephemeral shell that spawned `ak` (which dies in milliseconds and causes the
 * daemon to immediately reap the session).
 */
export function findRuntimeAncestorPid(runtime: string): number | null {
  const pattern = RUNTIMES[runtime]?.commandPattern;
  if (!pattern) return null;
  const override = Number.parseInt(process.env.AK_LEADER_PID ?? "", 10);
  if (Number.isInteger(override) && override > 0) return override;
  if (process.platform === "win32") return findDaemonAnchorPid();
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    const info = readProcess(pid);
    if (!info) return null;
    if (pattern.test(info.command)) return pid;
    pid = info.ppid;
  }
  return null;
}

/**
 * Windows fallback: POSIX `ps` does not exist and the WMI/PowerShell
 * equivalents can hang for minutes on some machines, so the parent chain
 * cannot be walked reliably. Anchor leader sessions to the daemon process
 * instead — the only long-lived local pid discoverable without WMI. Callers
 * that need a precise anchor can set AK_LEADER_PID explicitly.
 */
function findDaemonAnchorPid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) return pid;
  } catch {
    /* no daemon pid file — same as "no ancestor found" */
  }
  return null;
}
