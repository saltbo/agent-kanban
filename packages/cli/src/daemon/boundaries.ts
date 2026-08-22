/**
 * Boundary adapters — the ONLY place try/catch is allowed in daemon code.
 *
 * Each function wraps one external dependency call, catches the raw error,
 * and throws a ClassifiedError. Business code never sees raw errors; it
 * reads `.kind` and routes to state-machine events.
 *
 * Categories:
 *   api      — ApiClient calls (getTask, createSession, releaseTask, etc.)
 *   provider — provider.execute, handle iteration, handle.abort
 *   fs       — workspace create/cleanup, session file ops
 *   exec     — gh CLI and git worktree operations
 *   tunnel   — WebSocket send/recv
 */

import { ApiError } from "../client/index.js";
import { CleanupError, classify, TerminalError, TransientError } from "./errors.js";

// ---- API Client ----

/**
 * Wrap an ApiClient call. 404 returns null instead of throwing (common
 * pattern: "does this task still exist?"). All other errors are classified.
 */
export async function apiCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classify(err, `api:${label}`);
  }
}

/**
 * ApiClient call where 404 means "gone, not an error" — returns null.
 */
export async function apiCallOptional<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw classify(err, `api:${label}`);
  }
}

/**
 * ApiClient call where 409 (conflict) also returns null — for idempotent
 * create-or-skip patterns like createSession.
 */
export async function apiCallIdempotent<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 404)) return null;
    throw classify(err, `api:${label}`);
  }
}

/**
 * Fire-and-forget API call — errors are logged but never thrown. Used for
 * non-critical reporting (usage, close-session) where failure must not
 * block the main flow.
 */
export async function apiFireAndForget(label: string, fn: () => Promise<unknown>, log: (msg: string) => void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- Provider ----

export async function providerExecute<T>(providerName: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classify(err, `provider:${providerName}`);
  }
}

// ---- Filesystem / Workspace ----

export function fsSync<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "EBUSY" || code === "EAGAIN") {
      throw new TransientError(`fs:${label}: ${code}`, err);
    }
    if (code === "ENOENT" || code === "EACCES") {
      throw new TerminalError(`fs:${label}: ${code}`, err);
    }
    throw classify(err, `fs:${label}`);
  }
}

/**
 * Workspace cleanup boundary — errors become CleanupError so the caller
 * can set `cleanupPending` instead of silently swallowing.
 */
export function cleanupSync(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    throw new CleanupError(`cleanup:${label}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// ---- External commands (gh, git) ----

export function execBoundary<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw classify(err, `exec:${label}`);
  }
}

export async function execBoundaryAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classify(err, `exec:${label}`);
  }
}

// ---- Crypto ----

export async function cryptoBoundary<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new TerminalError(`crypto:${label}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}
