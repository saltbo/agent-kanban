/**
 * UsageCollector — polls provider usage APIs on an independent schedule
 * with per-provider backoff, and exposes a synchronous snapshot to the
 * heartbeat loop.
 *
 * Why this exists
 * ---------------
 * Heartbeat ticks every 30s, but the Anthropic / OpenAI usage endpoints
 * don't need to be hit that often — usage windows are hour/day scale and
 * the endpoints themselves rate-limit aggressively. Previously the
 * provider did its own inline 5-min caching, but when a request failed
 * it returned the stale cache *without* advancing the cache timestamp,
 * so every subsequent heartbeat retried and flooded the log. This
 * collector is the single owner of that policy.
 *
 * Responsibilities
 * ----------------
 * - Own one polling schedule per provider (independent timers).
 * - Apply backoff on failure: honour HTTP `Retry-After`, fall back to a
 *   fixed window on 429 without header, otherwise exponential backoff.
 * - Preserve last-known-good windows so a transient failure doesn't wipe
 *   the UI.
 * - Only log on health-state transitions (healthy↔failing). No per-tick
 *   noise.
 */

import { createLogger } from "../logger.js";
import type { AgentProvider, UsageInfo, UsageWindow } from "../providers/types.js";
import { UsageFetchError } from "../providers/types.js";

const logger = createLogger("usage-collector");

const DEFAULT_SUCCESS_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000; // 30 min for 429 with no Retry-After
const DEFAULT_MAX_BACKOFF_MS = 30 * 60 * 1000; // 30 min cap on exponential backoff
const BASE_BACKOFF_MS = 60 * 1000; // 1 min initial exponential-backoff step

export interface UsageCollectorOptions {
  providers: AgentProvider[];
  successIntervalMs?: number;
  rateLimitBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable scheduler for deterministic tests. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export type TimerHandle = unknown;

interface ProviderState {
  /** Last successfully observed windows for this provider (kept across failures). */
  windows: UsageWindow[];
  /** Epoch ms of the most recent successful fetch; 0 if never succeeded. */
  lastSuccessAt: number;
  /** Number of consecutive failures since the last success. */
  consecutiveFailures: number;
  /** Health flag — flips only when crossing the boundary, gates log output. */
  healthy: boolean;
}

export class UsageCollector {
  private readonly providers: AgentProvider[];
  private readonly successIntervalMs: number;
  private readonly rateLimitBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  private readonly states = new Map<string, ProviderState>();
  private readonly timers = new Map<string, TimerHandle>();
  private running = false;

  constructor(opts: UsageCollectorOptions) {
    this.providers = opts.providers.filter((p) => typeof p.fetchUsage === "function");
    this.successIntervalMs = opts.successIntervalMs ?? DEFAULT_SUCCESS_INTERVAL_MS;
    this.rateLimitBackoffMs = opts.rateLimitBackoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Kick off an immediate tick for every provider. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const provider of this.providers) {
      this.states.set(provider.name, initialState());
      this.schedule(provider, 0);
    }
  }

  /** Cancel all pending timers. Does not drop cached windows. */
  stop(): void {
    this.running = false;
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  /**
   * Synchronous, non-blocking snapshot of the most recent usage data
   * across all providers. Returns `null` only when no provider has ever
   * reported a successful fetch.
   */
  getSnapshot(): UsageInfo | null {
    const windows: UsageWindow[] = [];
    let latestSuccess = 0;
    for (const state of this.states.values()) {
      if (state.lastSuccessAt === 0) continue;
      windows.push(...state.windows);
      if (state.lastSuccessAt > latestSuccess) latestSuccess = state.lastSuccessAt;
    }
    if (windows.length === 0) return null;
    return { windows, updated_at: new Date(latestSuccess).toISOString() };
  }

  private schedule(provider: AgentProvider, delayMs: number): void {
    if (!this.running) return;
    const existing = this.timers.get(provider.name);
    if (existing !== undefined) this.clearTimer(existing);
    const handle = this.setTimer(() => {
      this.tick(provider).catch((err: unknown) => {
        // tick() already catches fetch errors; anything reaching here is a
        // bug in the collector itself. Surface loudly.
        logger.error(`Unexpected error in usage tick for "${provider.name}": ${(err as Error).message}`);
      });
    }, delayMs);
    this.timers.set(provider.name, handle);
  }

  private async tick(provider: AgentProvider): Promise<void> {
    // `start()` installs a state entry for every provider before scheduling,
    // so the map lookup is guaranteed to hit.
    const state = this.states.get(provider.name)!;
    let nextDelayMs: number;

    try {
      const info = await provider.fetchUsage!();
      // `null` means "no credentials configured" — treat as a quiet success
      // (we have nothing to report, but there's no failure to back off on).
      if (info !== null) {
        state.windows = info.windows;
        state.lastSuccessAt = this.now();
      }
      if (!state.healthy) {
        logger.info(`Usage fetch recovered for "${provider.name}"`);
      }
      state.healthy = true;
      state.consecutiveFailures = 0;
      nextDelayMs = this.successIntervalMs;
    } catch (err) {
      state.consecutiveFailures += 1;
      const wasHealthy = state.healthy;
      state.healthy = false;
      if (wasHealthy) {
        logger.warn(`Usage fetch failing for "${provider.name}": ${(err as Error).message}`);
      }
      nextDelayMs = this.computeBackoff(err, state.consecutiveFailures);
    }

    this.schedule(provider, nextDelayMs);
  }

  private computeBackoff(err: unknown, consecutiveFailures: number): number {
    if (err instanceof UsageFetchError) {
      if (err.retryAfterMs !== undefined) {
        // Respect server directive but bound it so a broken header can't
        // stall us forever.
        return Math.min(Math.max(err.retryAfterMs, BASE_BACKOFF_MS), this.maxBackoffMs);
      }
      if (err.status === 429) return this.rateLimitBackoffMs;
    }
    const exponential = BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1);
    return Math.min(exponential, this.maxBackoffMs);
  }
}

function initialState(): ProviderState {
  return { windows: [], lastSuccessAt: 0, consecutiveFailures: 0, healthy: true };
}
