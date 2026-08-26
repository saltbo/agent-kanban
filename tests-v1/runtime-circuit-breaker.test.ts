import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeCircuitBreaker } from "../packages/cli/src/daemon/runtimeCircuitBreaker";

describe("RuntimeCircuitBreaker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a runtime circuit after the same task reaches the failure threshold", () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    expect(breaker.canDispatch("codex")).toBe(true);

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");

    expect(breaker.canDispatch("codex")).toBe(false);
    expect(breaker.pauseResetAt("codex")).toEqual(expect.any(String));
  });

  it("tracks task failures independently before opening the runtime circuit", () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 3, cooldownMs: 60_000 });

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    breaker.recordPreClaimFailure("codex", "task-2", "agent exited before claim");

    expect(breaker.canDispatch("codex")).toBe(true);
  });

  it("allows one half-open probe after cooldown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    expect(breaker.canDispatch("codex")).toBe(false);

    vi.setSystemTime(new Date("2026-05-19T12:01:01Z"));

    expect(breaker.canDispatch("codex")).toBe(true);
    expect(breaker.tryAcquireDispatch("codex")).toBe(true);
    expect(breaker.canDispatch("codex")).toBe(false);
  });

  it("closes the circuit after successful workflow entry", () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    expect(breaker.canDispatch("codex")).toBe(false);

    breaker.recordWorkflowEntered("codex");

    expect(breaker.canDispatch("codex")).toBe(true);
    expect(breaker.pauseResetAt("codex")).toBeNull();
  });

  it("releases a half-open probe when dispatch does not start", () => {
    const breaker = new RuntimeCircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });

    breaker.recordPreClaimFailure("codex", "task-1", "agent exited before claim");
    expect(breaker.tryAcquireDispatch("codex")).toBe(true);
    expect(breaker.canDispatch("codex")).toBe(false);

    breaker.releaseDispatch("codex");

    expect(breaker.canDispatch("codex")).toBe(true);
  });
});
