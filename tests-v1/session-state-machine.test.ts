// @vitest-environment node

import { describe, expect, it } from "vitest";
import { applyTransition, classifyIteratorEnd, TransitionError } from "../packages/cli/src/session/stateMachine.js";

// ─── classifyIteratorEnd ────────────────────────────────────────────────────

describe("classifyIteratorEnd", () => {
  // rateLimited priority (checked before crashed)

  it("returns iterator_done_rate_limited when rateLimited is true, even if crashed is also true", () => {
    const event = classifyIteratorEnd({
      rateLimited: true,
      crashed: true,
      resultReceived: true,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_rate_limited");
  });

  it("returns iterator_done_rate_limited when rateLimited is true and crashed is false", () => {
    const event = classifyIteratorEnd({
      rateLimited: true,
      crashed: false,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_rate_limited");
  });

  it("returns iterator_done_rate_limited when rateLimited is true regardless of resultReceived", () => {
    const event = classifyIteratorEnd({
      rateLimited: true,
      crashed: false,
      resultReceived: true,
      taskInReview: true,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_rate_limited");
  });

  // crashed (only when rateLimited is false)

  it("returns iterator_crashed when crashed is true and rateLimited is false", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: true,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_crashed");
  });

  it("returns iterator_crashed when crashed is true even if resultReceived is true", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: true,
      resultReceived: true,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_crashed");
  });

  // resultReceived with taskInReview

  it("returns iterator_done_with_result with taskInReview false when resultReceived is true and taskInReview is false", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: true,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_with_result");
    if (event.type === "iterator_done_with_result") {
      expect(event.taskInReview).toBe(false);
    }
  });

  it("returns iterator_done_with_result with taskInReview true when resultReceived is true and taskInReview is true", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: true,
      taskInReview: true,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_with_result");
    if (event.type === "iterator_done_with_result") {
      expect(event.taskInReview).toBe(true);
    }
  });

  // normal exit — all flags false

  it("returns iterator_done_normal when all flags are false", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_normal");
  });

  // taskInReview is ignored when resultReceived is false

  it("returns iterator_done_normal when resultReceived is false even if taskInReview is true", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: false,
      taskInReview: true,
      transient: false,
    });
    expect(event.type).toBe("iterator_done_normal");
  });
});

// ─── applyTransition ─────────────────────────────────────────────────────────

describe("applyTransition — active state", () => {
  it("active + rate_limit_cleared → active", () => {
    expect(applyTransition("active", { type: "rate_limit_cleared" })).toBe("active");
  });

  it("active + iterator_done_normal → completing", () => {
    expect(applyTransition("active", { type: "iterator_done_normal" })).toBe("completing");
  });

  it("active + iterator_done_rate_limited → rate_limited", () => {
    expect(applyTransition("active", { type: "iterator_done_rate_limited" })).toBe("rate_limited");
  });

  it("active + iterator_crashed → completing", () => {
    expect(applyTransition("active", { type: "iterator_crashed" })).toBe("completing");
  });

  it("active + iterator_done_with_result (taskInReview=false) → completing", () => {
    expect(applyTransition("active", { type: "iterator_done_with_result", taskInReview: false })).toBe("completing");
  });

  it("active + iterator_done_with_result (taskInReview=true) → in_review", () => {
    expect(applyTransition("active", { type: "iterator_done_with_result", taskInReview: true })).toBe("in_review");
  });

  it("active + task_cancelled → completing", () => {
    expect(applyTransition("active", { type: "task_cancelled" })).toBe("completing");
  });

  it("active + orphan_detected → completing", () => {
    expect(applyTransition("active", { type: "orphan_detected" })).toBe("completing");
  });

  it("active + illegal event throws TransitionError", () => {
    expect(() => applyTransition("active", { type: "cleanup_done" })).toThrow(TransitionError);
  });
});

describe("applyTransition — rate_limited state", () => {
  it("rate_limited + resume_started → active", () => {
    expect(applyTransition("rate_limited", { type: "resume_started" })).toBe("active");
  });

  it("rate_limited + resume_failed_transient → rate_limited", () => {
    expect(applyTransition("rate_limited", { type: "resume_failed_transient" })).toBe("rate_limited");
  });

  it("rate_limited + resume_failed_terminal → completing", () => {
    expect(applyTransition("rate_limited", { type: "resume_failed_terminal" })).toBe("completing");
  });

  it("rate_limited + task_cancelled → completing", () => {
    expect(applyTransition("rate_limited", { type: "task_cancelled" })).toBe("completing");
  });

  it("rate_limited + task_deleted → completing", () => {
    expect(applyTransition("rate_limited", { type: "task_deleted" })).toBe("completing");
  });

  it("rate_limited + orphan_detected → completing", () => {
    expect(applyTransition("rate_limited", { type: "orphan_detected" })).toBe("completing");
  });

  it("rate_limited + illegal event throws TransitionError", () => {
    expect(() => applyTransition("rate_limited", { type: "cleanup_done" })).toThrow(TransitionError);
  });
});

describe("applyTransition — in_review state", () => {
  it("in_review + rejected_by_reviewer → active", () => {
    expect(applyTransition("in_review", { type: "rejected_by_reviewer" })).toBe("active");
  });

  it("in_review + resume_started → active", () => {
    expect(applyTransition("in_review", { type: "resume_started" })).toBe("active");
  });

  it("in_review + resume_failed_transient → in_review", () => {
    expect(applyTransition("in_review", { type: "resume_failed_transient" })).toBe("in_review");
  });

  it("in_review + resume_failed_terminal → completing", () => {
    expect(applyTransition("in_review", { type: "resume_failed_terminal" })).toBe("completing");
  });

  it("in_review + task_cancelled → completing", () => {
    expect(applyTransition("in_review", { type: "task_cancelled" })).toBe("completing");
  });

  it("in_review + task_deleted → completing", () => {
    expect(applyTransition("in_review", { type: "task_deleted" })).toBe("completing");
  });

  it("in_review + orphan_detected throws TransitionError (in_review sessions survive restart)", () => {
    expect(() => applyTransition("in_review", { type: "orphan_detected" })).toThrow(TransitionError);
  });

  it("in_review + cleanup_done throws TransitionError", () => {
    expect(() => applyTransition("in_review", { type: "cleanup_done" })).toThrow(TransitionError);
  });
});

describe("applyTransition — completing state", () => {
  it("completing + cleanup_done → closed", () => {
    expect(applyTransition("completing", { type: "cleanup_done" })).toBe("closed");
  });

  it("completing + illegal event throws TransitionError", () => {
    expect(() => applyTransition("completing", { type: "iterator_done_normal" })).toThrow(TransitionError);
  });
});

describe("applyTransition — terminal state", () => {
  it("terminal + any event throws TransitionError", () => {
    expect(() => applyTransition("terminal", { type: "cleanup_done" })).toThrow(TransitionError);
  });

  it("terminal + iterator_done_normal throws TransitionError", () => {
    expect(() => applyTransition("terminal", { type: "iterator_done_normal" })).toThrow(TransitionError);
  });
});

describe("TransitionError", () => {
  it("carries from state and event type in the error message", () => {
    const err = new TransitionError("active", "cleanup_done");
    expect(err.message).toContain("active");
    expect(err.message).toContain("cleanup_done");
    expect(err.name).toBe("TransitionError");
    expect(err.from).toBe("active");
    expect(err.event).toBe("cleanup_done");
  });
});

// ─── combined: classifyIteratorEnd → applyTransition ─────────────────────────
//
// Verifies the two changed pieces work together correctly. The key invariant:
// when both rateLimited and crashed are set, the result must be rate_limited
// (not completing, which crashed alone would produce).

describe("classifyIteratorEnd feeds into applyTransition correctly", () => {
  it("rate_limited+crashed combo → rate_limited state (worktree preserved)", () => {
    const event = classifyIteratorEnd({
      rateLimited: true,
      crashed: true,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    const nextState = applyTransition("active", event);
    expect(nextState).toBe("rate_limited");
  });

  it("crashed only → completing state (worktree cleaned up)", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: true,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    const nextState = applyTransition("active", event);
    expect(nextState).toBe("completing");
  });

  it("crashed+transient → rate_limited state (worktree preserved)", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: true,
      resultReceived: false,
      taskInReview: false,
      transient: true,
    });
    const nextState = applyTransition("active", event);
    expect(nextState).toBe("rate_limited");
  });

  it("resultReceived+taskInReview → in_review state (reject-resume path)", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: true,
      taskInReview: true,
      transient: false,
    });
    const nextState = applyTransition("active", event);
    expect(nextState).toBe("in_review");
  });

  it("normal exit → completing state", () => {
    const event = classifyIteratorEnd({
      rateLimited: false,
      crashed: false,
      resultReceived: false,
      taskInReview: false,
      transient: false,
    });
    const nextState = applyTransition("active", event);
    expect(nextState).toBe("completing");
  });
});
