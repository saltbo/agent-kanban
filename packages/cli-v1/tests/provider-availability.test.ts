// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { availabilityFromUsage, availabilityFromUsageError, UsageFetchError } from "../src/providers/types.js";

describe("provider availability helpers", () => {
  it("reports ready when usage is absent or below its limit", () => {
    expect(availabilityFromUsage(null)).toEqual({ status: "ready" });
    expect(
      availabilityFromUsage({
        updated_at: "2026-03-21T10:00:00.000Z",
        windows: [{ runtime: "claude", label: "5-Hour", utilization: 50, resets_at: "2026-03-21T12:00:00.000Z" }],
      }),
    ).toEqual({ status: "ready" });
  });

  it("reports limited when a usage window is exhausted", () => {
    expect(
      availabilityFromUsage({
        updated_at: "2026-03-21T10:00:00.000Z",
        windows: [{ runtime: "codex", label: "5-Hour", utilization: 100, resets_at: "2026-03-21T12:00:00.000Z" }],
      }),
    ).toEqual({
      status: "limited",
      detail: "runtime usage limit reached",
      reset_at: "2026-03-21T12:00:00.000Z",
    });
  });

  it("maps usage probe errors to runtime statuses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-21T10:00:00.000Z"));

    expect(availabilityFromUsageError(new UsageFetchError("failed", { status: 401 }), "Codex")).toEqual({
      status: "unauthorized",
      detail: "Codex authentication failed",
    });
    expect(availabilityFromUsageError(new UsageFetchError("forbidden", { status: 403 }), "Codex")).toEqual({
      status: "unauthorized",
      detail: "Codex authentication failed",
    });
    expect(availabilityFromUsageError(new UsageFetchError("limited", { status: 429, retryAfterMs: 60_000 }), "Codex")).toEqual({
      status: "limited",
      detail: "Codex usage limit reached",
      reset_at: "2026-03-21T10:01:00.000Z",
    });
    expect(availabilityFromUsageError(new UsageFetchError("server failed", { status: 500 }), "Codex")).toEqual({
      status: "unhealthy",
      detail: "server failed",
    });
    expect(availabilityFromUsageError(new Error("network down"), "Codex")).toEqual({
      status: "unhealthy",
      detail: "Codex usage probe failed: network down",
    });

    vi.useRealTimers();
  });
});
