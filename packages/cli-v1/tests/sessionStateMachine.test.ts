// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyTransition, classifyIteratorEnd, type SessionEvent, type SessionState, TransitionError } from "../src/session/stateMachine.js";

describe("applyTransition — active", () => {
  it.each<[SessionEvent, SessionState]>([
    [{ type: "rate_limit_cleared" }, "active"],
    [{ type: "iterator_done_with_result", taskInReview: true }, "in_review"],
    [{ type: "iterator_done_with_result", taskInReview: false }, "completing"],
    [{ type: "iterator_done_rate_limited" }, "rate_limited"],
    [{ type: "iterator_done_normal" }, "completing"],
    [{ type: "iterator_crashed" }, "completing"],
    [{ type: "task_cancelled" }, "completing"],
    [{ type: "orphan_detected" }, "completing"],
  ])("active -(%o)-> %s", (event, expected) => {
    expect(applyTransition("active", event)).toBe(expected);
  });

  it.each<SessionEvent["type"]>([
    "resume_started",
    "resume_failed_transient",
    "resume_failed_terminal",
    "rejected_by_reviewer",
    "cleanup_done",
    "task_deleted",
  ])("rejects %s from active", (type) => {
    expect(() => applyTransition("active", { type } as SessionEvent)).toThrow(TransitionError);
  });
});

describe("applyTransition — rate_limited", () => {
  it.each<[SessionEvent, SessionState]>([
    [{ type: "resume_started" }, "active"],
    [{ type: "resume_failed_transient" }, "rate_limited"],
    [{ type: "resume_failed_terminal" }, "completing"],
    [{ type: "task_cancelled" }, "completing"],
    [{ type: "task_deleted" }, "completing"],
    [{ type: "orphan_detected" }, "completing"],
  ])("rate_limited -(%o)-> %s", (event, expected) => {
    expect(applyTransition("rate_limited", event)).toBe(expected);
  });

  it.each<SessionEvent["type"]>([
    "iterator_done_normal",
    "iterator_done_rate_limited",
    "iterator_crashed",
    "rejected_by_reviewer",
    "cleanup_done",
  ])("rejects %s from rate_limited", (type) => {
    expect(() => applyTransition("rate_limited", { type } as SessionEvent)).toThrow(TransitionError);
  });
});

describe("applyTransition — in_review", () => {
  it.each<[SessionEvent, SessionState]>([
    [{ type: "rejected_by_reviewer" }, "active"],
    [{ type: "resume_started" }, "active"],
    [{ type: "resume_failed_transient" }, "in_review"],
    [{ type: "resume_failed_terminal" }, "completing"],
    [{ type: "task_cancelled" }, "completing"],
    [{ type: "task_deleted" }, "completing"],
  ])("in_review -(%o)-> %s", (event, expected) => {
    expect(applyTransition("in_review", event)).toBe(expected);
  });

  it("in_review sessions are never orphan-reaped", () => {
    expect(() => applyTransition("in_review", { type: "orphan_detected" })).toThrow(TransitionError);
  });
});

describe("applyTransition — completing", () => {
  it("cleanup_done → closed", () => {
    expect(applyTransition("completing", { type: "cleanup_done" })).toBe("closed");
  });

  it.each<SessionEvent["type"]>([
    "iterator_done_normal",
    "iterator_done_rate_limited",
    "iterator_crashed",
    "rate_limit_cleared",
    "rejected_by_reviewer",
    "resume_started",
    "task_cancelled",
    "task_deleted",
    "orphan_detected",
  ])("rejects %s from completing", (type) => {
    expect(() => applyTransition("completing", { type } as SessionEvent)).toThrow(TransitionError);
  });
});

describe("applyTransition — terminal", () => {
  it("terminal rejects any event (session file is gone)", () => {
    expect(() => applyTransition("terminal", { type: "cleanup_done" })).toThrow(TransitionError);
    expect(() => applyTransition("terminal", { type: "iterator_done_normal" })).toThrow(TransitionError);
  });
});

describe("classifyIteratorEnd", () => {
  it("rateLimited takes precedence over crashed", () => {
    expect(classifyIteratorEnd({ resultReceived: true, rateLimited: true, taskInReview: true, crashed: true, transient: false })).toEqual({
      type: "iterator_done_rate_limited",
    });
  });

  it("result + in_review → iterator_done_with_result(true)", () => {
    expect(classifyIteratorEnd({ resultReceived: true, rateLimited: false, taskInReview: true, crashed: false, transient: false })).toEqual({
      type: "iterator_done_with_result",
      taskInReview: true,
    });
  });

  it("result + not in_review → iterator_done_with_result(false)", () => {
    expect(classifyIteratorEnd({ resultReceived: true, rateLimited: false, taskInReview: false, crashed: false, transient: false })).toEqual({
      type: "iterator_done_with_result",
      taskInReview: false,
    });
  });

  it("rate limited without result → iterator_done_rate_limited", () => {
    expect(classifyIteratorEnd({ resultReceived: false, rateLimited: true, taskInReview: false, crashed: false, transient: false })).toEqual({
      type: "iterator_done_rate_limited",
    });
  });

  it("neither rate limited nor result → iterator_done_normal", () => {
    expect(classifyIteratorEnd({ resultReceived: false, rateLimited: false, taskInReview: false, crashed: false, transient: false })).toEqual({
      type: "iterator_done_normal",
    });
  });
});

describe("TransitionError", () => {
  it("carries the from state and event type", () => {
    try {
      applyTransition("completing", { type: "iterator_done_normal" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      expect(te.from).toBe("completing");
      expect(te.event).toBe("iterator_done_normal");
      expect(te.message).toContain("Illegal session transition");
    }
  });
});
