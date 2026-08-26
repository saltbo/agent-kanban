import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isVersionBelowMin } from "@agent-kanban/shared";
import { STATE_DIR } from "./paths.js";
import { getVersion } from "./version.js";

const CACHE_FILE = join(STATE_DIR, "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PACKAGE_NAME = "agent-kanban";

interface CacheData {
  latest: string;
  checkedAt: number;
}

function readCache(): CacheData | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (Date.now() - raw.checkedAt < CACHE_TTL_MS) return raw;
  } catch {}
  return null;
}

function writeCache(latest: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify({ latest, checkedAt: Date.now() }));
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

export function isNpx(): boolean {
  return process.argv[1]?.includes("_npx/") || process.env.npm_command === "exec";
}

export function isWorkerAgent(): boolean {
  return process.env.AK_WORKER === "1";
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

/** Check for updates (fire-and-forget safe). Returns info if newer version available. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = getVersion();

  const cached = readCache();
  if (cached) {
    return isVersionBelowMin(current, cached.latest) ? { current, latest: cached.latest } : null;
  }

  // Fire-and-forget: cache write may not complete for fast commands; TTL is advisory
  const latest = await fetchLatestVersion();
  if (!latest) return null;

  writeCache(latest);
  return isVersionBelowMin(current, latest) ? { current, latest } : null;
}
