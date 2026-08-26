import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUsageInput } from "@agent-kanban/shared";

function findRecentJsonl(dir: string, startedAt: number, recursive = false): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory() && recursive) {
      const found = findRecentJsonl(full, startedAt, true);
      if (found) return found;
    }
    if (entry.endsWith(".jsonl") && stat.mtimeMs >= startedAt) return full;
  }
  return null;
}

function parseClaudeUsage(startedAt: number): SessionUsageInput | null {
  const projectHash = process.cwd().replace(/\//g, "-");
  const projectDir = join(homedir(), ".claude", "projects", projectHash);
  const file = findRecentJsonl(projectDir, startedAt);
  if (!file) return null;

  const usage: SessionUsageInput = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_micro_usd: 0,
  };

  const lines = readFileSync(file, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const u = obj.message.usage;
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_tokens += u.cache_creation_input_tokens ?? 0;
  }

  return usage;
}

function parseCodexUsage(startedAt: number): SessionUsageInput | null {
  const codexHome = join(homedir(), ".codex");
  // Active sessions in sessions/YYYY/MM/DD/, archived in archived_sessions/
  const file = findRecentJsonl(join(codexHome, "sessions"), startedAt, true) ?? findRecentJsonl(join(codexHome, "archived_sessions"), startedAt);
  if (!file) return null;

  const lines = readFileSync(file, "utf-8").split("\n");
  let lastTokenLine: any = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === "event_msg" && obj.payload?.type === "token_count" && obj.payload.info?.total_token_usage) {
      lastTokenLine = obj.payload.info.total_token_usage;
    }
  }

  if (!lastTokenLine) return null;

  return {
    input_tokens: lastTokenLine.input_tokens ?? 0,
    output_tokens: lastTokenLine.output_tokens ?? 0,
    cache_read_tokens: lastTokenLine.cached_input_tokens ?? 0,
    cache_creation_tokens: 0,
    cost_micro_usd: 0,
  };
}

export async function collectUsage(runtimeName: string, startedAt: number): Promise<SessionUsageInput | null> {
  switch (runtimeName) {
    case "claude":
      return parseClaudeUsage(startedAt);
    case "codex":
      return parseCodexUsage(startedAt);
    default:
      return null;
  }
}
