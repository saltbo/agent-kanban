/**
 * Low-level session file I/O.
 *
 * THIS MODULE IS INTERNAL. Prefer `SessionManager` in manager.ts for all
 * session state changes. Direct callers of this module bypass the mutex and
 * the state machine, and are the historical source of the worktree leak and
 * lost-update bugs. New code MUST use SessionManager.
 *
 * The only legitimate direct callers are:
 *   - SessionManager itself (implementation)
 *   - leader.ts (leader sessions, which have a different lifecycle)
 *   - cleanup.ts (leader cleanup only)
 *   - commands/start.ts legacy URL-change wipe path
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGACY_SAVED_SESSIONS_FILE, LEGACY_SESSION_PIDS_FILE, SESSIONS_DIR } from "../paths.js";
import type { SessionFile, SessionFilter } from "./types.js";

export type { SessionFile, SessionFilter, SessionStatus } from "./types.js";

function sessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function writeSession(session: SessionFile): void {
  ensureDir();
  // Atomic write: tmp file + rename
  const tmp = join(tmpdir(), `ak-session-${randomUUID()}.json`);
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, sessionPath(session.sessionId));
}

export function readSession(sessionId: string): SessionFile | null {
  try {
    return JSON.parse(readFileSync(sessionPath(sessionId), "utf-8"));
  } catch {
    return null;
  }
}

export function findLeaderSession(pid: number): SessionFile | null {
  for (const session of listSessions()) {
    if (session.type === "leader" && session.pid === pid) return session;
  }
  return null;
}

export function removeSession(sessionId: string): void {
  try {
    unlinkSync(sessionPath(sessionId));
  } catch {
    /* already gone */
  }
}

export function listSessions(filter?: SessionFilter): SessionFile[] {
  ensureDir();
  const results: SessionFile[] = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const session: SessionFile = JSON.parse(readFileSync(join(SESSIONS_DIR, file), "utf-8"));
      if (filter?.type && session.type !== filter.type) continue;
      if (filter?.status && session.status !== filter.status) continue;
      results.push(session);
    } catch {
      /* skip corrupt files */
    }
  }
  return results;
}

export function updateSession(sessionId: string, updates: Partial<SessionFile>): boolean {
  const session = readSession(sessionId);
  if (!session) return false;
  writeSession({ ...session, ...updates });
  return true;
}

/**
 * TEST ONLY — wipes the sessions directory. Do NOT call from daemon code;
 * in_review session files are reject-resume entry points and must survive
 * every kind of restart. The only non-test caller is commands/start.ts when
 * the apiUrl changes, and that site inlines rmSync on purpose.
 */
export function clearAllSessions(): void {
  try {
    rmSync(SESSIONS_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * PID liveness check. Only meaningful for LEADER sessions, whose `pid` is a
 * long-lived external runtime (e.g. a CI step). Worker sessions no longer
 * carry a pid — their liveness is tracked in-memory by AgentRuntimePool.
 */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Migrate legacy saved-sessions.json + session-pids.json to per-session files. */
export function migrateLegacySessions(): void {
  let legacySessions: any[] = [];
  try {
    legacySessions = JSON.parse(readFileSync(LEGACY_SAVED_SESSIONS_FILE, "utf-8"));
  } catch {
    return; // No legacy file — nothing to migrate
  }

  try {
    // Legacy pid file existed for back-compat; no longer needed since worker
    // sessions have no pid, but we still consume and delete the file.
    JSON.parse(readFileSync(LEGACY_SESSION_PIDS_FILE, "utf-8"));
  } catch {
    /* no PID file — fine */
  }

  for (const s of legacySessions) {
    writeSession({
      type: "worker",
      agentId: s.agentId,
      sessionId: s.sessionId,
      runtime: s.runtime,
      startedAt: 0,
      apiUrl: "",
      privateKeyJwk: s.privateKeyJwk,
      taskId: s.taskId,
      workspace: s.workspace,
      status: s.status ?? "active",
      model: s.model,
      agentUsername: s.agentUsername,
      agentName: s.agentName,
    });
  }

  try {
    unlinkSync(LEGACY_SAVED_SESSIONS_FILE);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(LEGACY_SESSION_PIDS_FILE);
  } catch {
    /* ignore */
  }
}
