// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Use vi.hoisted so mock functions are available inside the vi.mock factory
const { mockWarn, mockInfo, mockError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: mockError,
    debug: vi.fn(),
  }),
}));

import type { UsageCollectorOptions } from "../src/daemon/usageCollector.js";
import { UsageCollector } from "../src/daemon/usageCollector.js";
import type { AgentProvider, UsageInfo } from "../src/providers/types.js";
import { parseRetryAfterMs, UsageFetchError } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake timer that captures scheduled callbacks so tests can fire them manually. */
function makeTimerControl() {
  const pending = new Map<symbol, { fn: () => void; ms: number }>();

  function setTimer(fn: () => void, ms: number): symbol {
    const key = Symbol();
    pending.set(key, { fn, ms });
    return key;
  }

  function clearTimer(handle: unknown) {
    pending.delete(handle as symbol);
  }

  /** Fire the next scheduled callback immediately. Returns the delay it was scheduled with. */
  function fireNext(): number | undefined {
    const [key, entry] = [...pending.entries()][0] ?? [];
    if (!entry) return undefined;
    pending.delete(key);
    entry.fn();
    return entry.ms;
  }

  /** Fire all currently pending callbacks (copies the snapshot first so re-schedules don't loop). */
  function fireAll(): void {
    const snap = [...pending.entries()];
    for (const [key] of snap) pending.delete(key);
    for (const [, entry] of snap) entry.fn();
  }

  function lastScheduledMs(): number | undefined {
    const entries = [...pending.values()];
    return entries[entries.length - 1]?.ms;
  }

  function pendingCount(): number {
    return pending.size;
  }

  return { setTimer, clearTimer, fireNext, fireAll, lastScheduledMs, pendingCount };
}

function makeProvider(name: string, fetchUsage: () => Promise<UsageInfo | null>): AgentProvider {
  return {
    name: name as any,
    label: name,
    execute: vi.fn() as any,
    fetchUsage,
  };
}

const NOW = 1_000_000;

function _baseOpts(providers: AgentProvider[], overrides: Partial<UsageCollectorOptions> = {}): UsageCollectorOptions {
  const ctrl = makeTimerControl();
  return {
    providers,
    successIntervalMs: 5 * 60 * 1000,
    rateLimitBackoffMs: 30 * 60 * 1000,
    maxBackoffMs: 30 * 60 * 1000,
    now: () => NOW,
    setTimer: ctrl.setTimer,
    clearTimer: ctrl.clearTimer,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseRetryAfterMs — unit tests
// ---------------------------------------------------------------------------

describe("parseRetryAfterMs — delta-seconds form", () => {
  it("returns milliseconds when header is an integer string", () => {
    expect(parseRetryAfterMs("120", 0)).toBe(120_000);
  });

  it("returns 0 ms when header is '0'", () => {
    expect(parseRetryAfterMs("0", 0)).toBe(0);
  });

  it("handles fractional seconds as finite number", () => {
    expect(parseRetryAfterMs("1.5", 0)).toBe(1500);
  });
});

describe("parseRetryAfterMs — HTTP-date form", () => {
  it("returns ms from now for a future HTTP-date", () => {
    const now = Date.parse("2026-04-11T10:00:00Z");
    const future = "2026-04-11T10:02:00Z"; // 2 min ahead
    const result = parseRetryAfterMs(future, now);
    expect(result).toBe(2 * 60 * 1000);
  });

  it("returns 0 when HTTP-date is in the past", () => {
    const now = Date.parse("2026-04-11T10:05:00Z");
    const past = "2026-04-11T10:00:00Z";
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });
});

describe("parseRetryAfterMs — missing or malformed", () => {
  it("returns undefined for null", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfterMs("")).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date string", () => {
    expect(parseRetryAfterMs("banana")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — getSnapshot() with no providers ever succeeded
// ---------------------------------------------------------------------------

describe("UsageCollector.getSnapshot — initial state", () => {
  it("returns null when no provider has ever fetched successfully", () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    // Don't start — snapshot should still be null
    expect(collector.getSnapshot()).toBeNull();
  });

  it("returns null immediately after start() before first tick fires", () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    // Timer is queued but not fired yet
    expect(collector.getSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — happy path
// ---------------------------------------------------------------------------

describe("UsageCollector — happy path", () => {
  it("calls fetchUsage immediately after start()", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ windows: [], updated_at: "" });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // fires the delay=0 immediate tick
    await Promise.resolve(); // let async tick run
    expect(fetchUsage).toHaveBeenCalledOnce();
  });

  it("getSnapshot() returns combined windows from all providers after first tick", async () => {
    const windowA = { runtime: "claude" as const, label: "5-Hour", utilization: 50, resets_at: "2026-04-11T12:00:00Z" };
    const windowB = { runtime: "codex" as const, label: "Weekly", utilization: 10, resets_at: "2026-04-18T00:00:00Z" };
    const providerA = makeProvider("claude", vi.fn().mockResolvedValue({ windows: [windowA], updated_at: "" }));
    const providerB = makeProvider("codex", vi.fn().mockResolvedValue({ windows: [windowB], updated_at: "" }));

    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [providerA, providerB],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireAll();
    await new Promise((r) => setImmediate(r)); // drain microtasks

    const snap = collector.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.windows).toHaveLength(2);
    expect(snap!.windows.map((w) => w.label)).toContain("5-Hour");
    expect(snap!.windows.map((w) => w.label)).toContain("Weekly");
  });

  it("schedules next tick at successIntervalMs after a successful fetch", async () => {
    const SUCCESS_INTERVAL = 5 * 60 * 1000;
    const fetchUsage = vi.fn().mockResolvedValue({ windows: [], updated_at: "" });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      successIntervalMs: SUCCESS_INTERVAL,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // fire immediate tick
    await new Promise((r) => setImmediate(r));

    // Next scheduled delay should equal successIntervalMs
    expect(ctrl.lastScheduledMs()).toBe(SUCCESS_INTERVAL);
  });

  it("getSnapshot() includes updated_at as ISO string", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({
      windows: [{ runtime: "claude" as const, label: "5-Hour", utilization: 30, resets_at: "2026-04-11T12:00:00Z" }],
      updated_at: "",
    });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));

    const snap = collector.getSnapshot();
    expect(snap).not.toBeNull();
    expect(typeof snap!.updated_at).toBe("string");
    expect(new Date(snap!.updated_at).toISOString()).toBe(snap!.updated_at);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — null from fetchUsage (no creds)
// ---------------------------------------------------------------------------

describe("UsageCollector — null fetchUsage (no creds)", () => {
  it("does not mark state as failing when fetchUsage returns null", async () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("schedules next tick at successIntervalMs when fetchUsage returns null", async () => {
    const SUCCESS_INTERVAL = 5 * 60 * 1000;
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      successIntervalMs: SUCCESS_INTERVAL,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(SUCCESS_INTERVAL);
  });

  it("getSnapshot() returns null when only provider returned null (no windows)", async () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(collector.getSnapshot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — last-known-good preservation on failure
// ---------------------------------------------------------------------------

describe("UsageCollector — last-known-good preserved on failure", () => {
  it("keeps previous windows when a subsequent fetch throws", async () => {
    const window1 = { runtime: "claude" as const, label: "5-Hour", utilization: 40, resets_at: "2026-04-11T12:00:00Z" };
    let callCount = 0;
    const fetchUsage = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ windows: [window1], updated_at: "" });
      return Promise.reject(new UsageFetchError("API down", { status: 503 }));
    });

    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();

    // First tick — success
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(collector.getSnapshot()!.windows).toHaveLength(1);

    // Second tick — failure
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));

    // Windows must still be the last-known-good set
    const snap = collector.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.windows).toHaveLength(1);
    expect(snap!.windows[0].label).toBe("5-Hour");
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — backoff on generic failure (exponential)
// ---------------------------------------------------------------------------

describe("UsageCollector — exponential backoff on generic failure", () => {
  const BASE_BACKOFF = 60 * 1000; // 1 min

  it("schedules first retry at BASE_BACKOFF (1 min) after first failure", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new Error("network error"));
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(BASE_BACKOFF);
  });

  it("doubles backoff on second consecutive failure", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new Error("network error"));
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    ctrl.fireNext(); // second failure
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(BASE_BACKOFF * 2);
  });

  it("caps backoff at maxBackoffMs", async () => {
    const MAX_BACKOFF = 2 * 60 * 1000; // small cap for test
    const fetchUsage = vi.fn().mockRejectedValue(new Error("down"));
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: MAX_BACKOFF,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    // Fire enough ticks to saturate the cap
    for (let i = 0; i < 6; i++) {
      ctrl.fireNext();
      await new Promise((r) => setImmediate(r));
    }
    expect(ctrl.lastScheduledMs()).toBe(MAX_BACKOFF);
  });

  it("resets backoff to successIntervalMs after recovery", async () => {
    const SUCCESS_INTERVAL = 5 * 60 * 1000;
    let callCount = 0;
    const fetchUsage = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.reject(new Error("down"));
      return Promise.resolve({ windows: [], updated_at: "" });
    });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      successIntervalMs: SUCCESS_INTERVAL,
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // fail 1
    await new Promise((r) => setImmediate(r));
    ctrl.fireNext(); // fail 2
    await new Promise((r) => setImmediate(r));
    ctrl.fireNext(); // success
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(SUCCESS_INTERVAL);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — 429 with Retry-After header
// ---------------------------------------------------------------------------

describe("UsageCollector — 429 with Retry-After header", () => {
  it("schedules next tick at retryAfterMs when Retry-After is present (bounded)", async () => {
    const RETRY_AFTER_MS = 10 * 60 * 1000; // 10 min — within [BASE_BACKOFF, maxBackoffMs]
    const err = new UsageFetchError("rate limited", { status: 429, retryAfterMs: RETRY_AFTER_MS });
    const fetchUsage = vi.fn().mockRejectedValue(err);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(RETRY_AFTER_MS);
  });

  it("clamps retryAfterMs to BASE_BACKOFF when server says less than 1 min", async () => {
    const SHORT_MS = 10 * 1000; // 10s — below BASE_BACKOFF
    const err = new UsageFetchError("rate limited", { status: 429, retryAfterMs: SHORT_MS });
    const fetchUsage = vi.fn().mockRejectedValue(err);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(60 * 1000); // BASE_BACKOFF
  });

  it("clamps retryAfterMs to maxBackoffMs when server says too long", async () => {
    const HUGE_MS = 999 * 60 * 1000;
    const MAX_BACKOFF = 30 * 60 * 1000;
    const err = new UsageFetchError("rate limited", { status: 429, retryAfterMs: HUGE_MS });
    const fetchUsage = vi.fn().mockRejectedValue(err);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      maxBackoffMs: MAX_BACKOFF,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(MAX_BACKOFF);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — 429 without Retry-After header
// ---------------------------------------------------------------------------

describe("UsageCollector — 429 without Retry-After header (uses rateLimitBackoffMs)", () => {
  it("schedules next tick at rateLimitBackoffMs when no Retry-After is present", async () => {
    const RATE_LIMIT_BACKOFF = 30 * 60 * 1000;
    const err = new UsageFetchError("rate limited", { status: 429 }); // no retryAfterMs
    const fetchUsage = vi.fn().mockRejectedValue(err);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      rateLimitBackoffMs: RATE_LIMIT_BACKOFF,
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(RATE_LIMIT_BACKOFF);
  });

  it("uses custom rateLimitBackoffMs when provided", async () => {
    const CUSTOM_RATE_LIMIT = 15 * 60 * 1000;
    const err = new UsageFetchError("rate limited", { status: 429 });
    const fetchUsage = vi.fn().mockRejectedValue(err);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      rateLimitBackoffMs: CUSTOM_RATE_LIMIT,
      maxBackoffMs: 30 * 60 * 1000,
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(ctrl.lastScheduledMs()).toBe(CUSTOM_RATE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — state-transition logging
// ---------------------------------------------------------------------------

describe("UsageCollector — state-transition logging", () => {
  beforeEach(() => {
    mockWarn.mockClear();
    mockInfo.mockClear();
    mockError.mockClear();
  });

  it("logs warn on first failure", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new UsageFetchError("down", { status: 503 }));
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(mockWarn).toHaveBeenCalledOnce();
  });

  it("does NOT log again on second consecutive failure (silent while broken)", async () => {
    const fetchUsage = vi.fn().mockRejectedValue(new UsageFetchError("down", { status: 503 }));
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // failure 1 → logs warn
    await new Promise((r) => setImmediate(r));
    mockWarn.mockClear();
    ctrl.fireNext(); // failure 2 → should NOT log
    await new Promise((r) => setImmediate(r));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("logs info once on recovery after failure", async () => {
    let callCount = 0;
    const fetchUsage = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new UsageFetchError("down", { status: 503 }));
      return Promise.resolve({ windows: [], updated_at: "" });
    });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // failure
    await new Promise((r) => setImmediate(r));
    mockInfo.mockClear();
    ctrl.fireNext(); // recovery
    await new Promise((r) => setImmediate(r));
    expect(mockInfo).toHaveBeenCalledOnce();
  });

  it("does NOT log warn when initially healthy (first fetch succeeds)", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ windows: [], updated_at: "" });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext();
    await new Promise((r) => setImmediate(r));
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — stop()
// ---------------------------------------------------------------------------

describe("UsageCollector — stop()", () => {
  it("cancels all pending timers after stop()", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ windows: [], updated_at: "" });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    collector.stop();
    expect(ctrl.pendingCount()).toBe(0);
  });

  it("does not schedule further ticks after stop()", async () => {
    const fetchUsage = vi.fn().mockResolvedValue({ windows: [], updated_at: "" });
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    ctrl.fireNext(); // fires immediate tick
    await new Promise((r) => setImmediate(r)); // tick completes, re-schedules next
    collector.stop();
    const timersBefore = ctrl.pendingCount();
    expect(timersBefore).toBe(0);
  });

  it("stop() is idempotent — calling twice does not throw", () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    collector.stop();
    expect(() => collector.stop()).not.toThrow();
  });

  it("start() is idempotent — calling twice does not double-start", async () => {
    const fetchUsage = vi.fn().mockResolvedValue(null);
    const provider = makeProvider("claude", fetchUsage);
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [provider],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    collector.start(); // second call should be no-op
    // Should only have one pending timer per provider
    expect(ctrl.pendingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UsageCollector — providers without fetchUsage are ignored
// ---------------------------------------------------------------------------

describe("UsageCollector — providers without fetchUsage", () => {
  it("ignores providers that do not have fetchUsage defined", () => {
    const providerNoUsage: AgentProvider = {
      name: "gemini" as any,
      label: "Gemini",
      execute: vi.fn() as any,
      // no fetchUsage
    };
    const ctrl = makeTimerControl();
    const collector = new UsageCollector({
      providers: [providerNoUsage],
      now: () => NOW,
      setTimer: ctrl.setTimer,
      clearTimer: ctrl.clearTimer,
    });
    collector.start();
    // No timers scheduled for providers without fetchUsage
    expect(ctrl.pendingCount()).toBe(0);
  });
});
