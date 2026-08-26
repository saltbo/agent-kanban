/**
 * Classified error types for the daemon.
 *
 * Every error that crosses a boundary (api client, provider, fs, git, tunnel,
 * gh cli) must be translated into one of these types before reaching business
 * code. Business code never touches raw errors — it reads `.kind` and makes
 * state-machine decisions.
 *
 * Classification:
 *   TRANSIENT   — retry later with backoff. Network, 5xx, EBUSY, pipe broken.
 *   TERMINAL    — cannot recover, task must be released + cleaned. Auth,
 *                 404, corrupt state, missing binary, bad key.
 *   RATE_LIMIT  — provider-specific rate limiting. Drives state machine
 *                 directly via rate_limited / resume_started events.
 *   CLEANUP     — terminal cleanup step failed. Flag session as
 *                 cleanup_pending; OrphanReaper retries.
 */

import { ApiError } from "../client/index.js";

export type ClassifiedErrorKind = "transient" | "terminal" | "rate_limit" | "cleanup";

export class ClassifiedError extends Error {
  public readonly cause?: unknown;
  constructor(
    public readonly kind: ClassifiedErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ClassifiedError";
    this.cause = cause;
  }
}

export class TransientError extends ClassifiedError {
  constructor(message: string, cause?: unknown) {
    super("transient", message, cause);
    this.name = "TransientError";
  }
}

export class TerminalError extends ClassifiedError {
  constructor(message: string, cause?: unknown) {
    super("terminal", message, cause);
    this.name = "TerminalError";
  }
}

export class RateLimitError extends ClassifiedError {
  constructor(
    message: string,
    public readonly resetAt: string | undefined,
    public readonly overage: { status: "allowed" | "rejected"; resetAt?: string } | undefined,
    cause?: unknown,
  ) {
    super("rate_limit", message, cause);
    this.name = "RateLimitError";
  }
}

export class CleanupError extends ClassifiedError {
  constructor(message: string, cause?: unknown) {
    super("cleanup", message, cause);
    this.name = "CleanupError";
  }
}

/**
 * Classify an error thrown from a boundary (api, provider, fs, git). If the
 * error is already a ClassifiedError, it passes through unchanged. Otherwise
 * the classifier makes the best guess based on error type/shape.
 *
 * Default: TerminalError. "Unknown error" is a terminal condition — if we
 * can't classify it, we must not quietly retry forever.
 */
export function classify(err: unknown, context: string): ClassifiedError {
  if (err instanceof ClassifiedError) return err;

  if (err instanceof ApiError) {
    if (err.status === 429) {
      return new TransientError(`${context}: rate limited (429)`, err);
    }
    if (err.status >= 500 && err.status < 600) {
      return new TransientError(`${context}: server error ${err.status}`, err);
    }
    if (err.status === 401 || err.status === 403) {
      return new TerminalError(`${context}: auth failed (${err.status})`, err);
    }
    if (err.status === 404) {
      return new TerminalError(`${context}: not found`, err);
    }
    if (err.status === 409) {
      return new TerminalError(`${context}: conflict (409)`, err);
    }
    return new TerminalError(`${context}: HTTP ${err.status}`, err);
  }

  const code = (err as { code?: string } | null)?.code;
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "EPIPE" || code === "EBUSY") {
    const msg = (err as Error).message ?? String(err);
    return new TransientError(`${context}: ${code} ${msg}`, err);
  }
  if (code === "ENOENT") {
    const msg = (err as Error).message ?? String(err);
    return new TerminalError(`${context}: ENOENT ${msg}`, err);
  }

  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError") {
    // Abort errors are expected during shutdown / timeout and should not be
    // reclassified as crashes. Caller must handle explicitly.
    return new TerminalError(`${context}: aborted`, err);
  }

  // The Anthropic SDK throws errors with a numeric `.status` property.
  // These aren't our ApiError class but carry the same HTTP status semantics.
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 500 && status < 600) {
    const msg = err instanceof Error ? err.message : String(err);
    return new TransientError(`${context}: ${msg}`, err);
  }

  const msg = err instanceof Error ? err.message : String(err);

  // Fallback: network-level failures from fetch (no status code).
  if (/\bfetch failed\b/.test(msg)) {
    return new TransientError(`${context}: ${msg}`, err);
  }

  return new TerminalError(`${context}: ${msg}`, err);
}

/** Helper for boundary adapters: wraps an async call and classifies on throw. */
export async function boundary<T>(context: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classify(err, context);
  }
}

/** Synchronous variant. */
export function boundarySync<T>(context: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw classify(err, context);
  }
}
