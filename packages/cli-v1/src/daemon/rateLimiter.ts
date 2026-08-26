/**
 * RateLimiter — runtime pause window management.
 *
 * Tracks which provider runtimes are rate-limited and when they can resume.
 * The pause window always takes the MAX of any existing window — fixes the
 * last-one-wins bug where a short fallback overwrote a long real reset.
 */

import { createLogger } from "../logger.js";

const logger = createLogger("rate-limiter");

interface RuntimePause {
  resumeMs: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface RateLimiterCallbacks {
  onResumed: (runtime: string) => void;
}

export class RateLimiter {
  private pausedRuntimes = new Map<string, RuntimePause>();
  private callbacks: RateLimiterCallbacks;

  constructor(callbacks: RateLimiterCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Pause a runtime until `resetAt`. If a longer-lived pause is already
   * active for this runtime, the existing window wins.
   */
  pause(runtime: string, resetAt: string): void {
    const resetTime = new Date(resetAt).getTime();
    const existing = this.pausedRuntimes.get(runtime);
    if (existing && existing.resumeMs >= resetTime) return;
    if (existing) clearTimeout(existing.timer);
    const waitMs = Math.max(resetTime - Date.now(), 60_000);
    logger.warn(`Runtime "${runtime}" rate limited — pausing until ${resetAt} (${Math.round(waitMs / 60_000)}min)`);
    const timer = setTimeout(() => this.fireResumed(runtime), waitMs);
    this.pausedRuntimes.set(runtime, { resumeMs: resetTime, timer });
  }

  /**
   * SDK reported main quota recovery. Clear the pause window and fire the
   * onResumed callback immediately.
   */
  resumeRateLimit(runtime: string): void {
    const existing = this.pausedRuntimes.get(runtime);
    if (!existing) return;
    clearTimeout(existing.timer);
    this.fireResumed(runtime);
  }

  isRuntimePaused(runtime: string): boolean {
    return this.pausedRuntimes.has(runtime);
  }

  pauseResetAt(runtime: string): string | null {
    const pause = this.pausedRuntimes.get(runtime);
    return pause ? new Date(pause.resumeMs).toISOString() : null;
  }

  stop(): void {
    for (const p of this.pausedRuntimes.values()) clearTimeout(p.timer);
    this.pausedRuntimes.clear();
  }

  private fireResumed(runtime: string): void {
    logger.info(`Rate limit window reset for "${runtime}"`);
    this.pausedRuntimes.delete(runtime);
    this.callbacks.onResumed(runtime);
  }
}
