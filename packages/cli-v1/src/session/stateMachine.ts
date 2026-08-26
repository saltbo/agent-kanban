/**
 * Session state machine — pure, no I/O.
 *
 * Every mutation to a worker session's status goes through `applyTransition`.
 * Illegal transitions throw — they are bugs, not runtime conditions. The
 * function is exhaustive: each (from, event) pair either returns the next
 * state or throws. No silent "stay in same state" fallbacks.
 *
 * States:
 *   active          agent is running (AgentRuntime holds the handle)
 *   rate_limited    agent exited with rate-limit flag, waiting for window
 *   in_review       agent produced a result and the task is in_review on the server.
 *                   This is the reject-resume entry point. MUST survive daemon
 *                   restart. Cleanup is forbidden in this state.
 *   completing      terminal cleanup in progress (workspace cleanup pending)
 *   closed          session finished, file retained for history lookup
 *   terminal        session file removed (only via explicit purge)
 */

export type SessionState = "active" | "rate_limited" | "in_review" | "completing" | "closed" | "terminal";

export type SessionEvent =
  // Fired while agent is live
  | { type: "rate_limit_cleared" } // noop transition, kept for symmetry

  // Fired when the event iterator ends (AgentRuntime decides which one)
  | { type: "iterator_done_normal" } // agent exited, no result received → completing
  | { type: "iterator_done_with_result"; taskInReview: boolean } // agent produced a result
  | { type: "iterator_done_rate_limited" } // agent exited before result due to rate limit
  | { type: "iterator_crashed" } // iterator threw an error
  | { type: "iterator_crashed_transient" } // iterator threw a transient error (API 5xx, network)

  // Fired by scheduler phases (outside the agent lifecycle)
  | { type: "rejected_by_reviewer" } // in_review → active (resume path)
  | { type: "resume_started" } // rate_limited / in_review → active
  | { type: "resume_failed_transient" } // stay in current state, retry next tick
  | { type: "resume_failed_terminal" } // drop to completing
  | { type: "orphan_detected" } // daemon restart found stale session
  | { type: "task_cancelled" } // user/reviewer cancelled task server-side
  | { type: "task_deleted" } // server returned 404

  // Fired at the end of cleanup
  | { type: "cleanup_done" };

export class TransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly event: SessionEvent["type"],
  ) {
    super(`Illegal session transition: ${from} -(${event})-> ?`);
    this.name = "TransitionError";
  }
}

export function applyTransition(from: SessionState, event: SessionEvent): SessionState {
  switch (from) {
    case "active":
      return activeTransitions(event);
    case "rate_limited":
      return rateLimitedTransitions(event);
    case "in_review":
      return inReviewTransitions(event);
    case "completing":
      return completingTransitions(event);
    case "closed":
    case "terminal":
      throw new TransitionError(from, event.type);
  }
}

function activeTransitions(event: SessionEvent): SessionState {
  switch (event.type) {
    case "rate_limit_cleared":
      return "active";
    case "iterator_done_with_result":
      return event.taskInReview ? "in_review" : "completing";
    case "iterator_done_rate_limited":
      return "rate_limited";
    case "iterator_done_normal":
      return "completing";
    case "iterator_crashed":
      return "completing";
    case "iterator_crashed_transient":
      return "rate_limited";
    case "task_cancelled":
      return "completing";
    case "orphan_detected":
      return "completing";
    default:
      throw new TransitionError("active", event.type);
  }
}

function rateLimitedTransitions(event: SessionEvent): SessionState {
  switch (event.type) {
    case "resume_started":
      return "active";
    case "resume_failed_transient":
      return "rate_limited";
    case "resume_failed_terminal":
      return "completing";
    case "task_cancelled":
    case "task_deleted":
    case "orphan_detected":
      return "completing";
    default:
      throw new TransitionError("rate_limited", event.type);
  }
}

function inReviewTransitions(event: SessionEvent): SessionState {
  switch (event.type) {
    case "rejected_by_reviewer":
    case "resume_started":
      return "active";
    case "resume_failed_transient":
      return "in_review";
    case "resume_failed_terminal":
      return "completing";
    case "task_cancelled":
    case "task_deleted":
      return "completing";
    // in_review sessions are NEVER orphan-reaped — they survive daemon restart.
    // An `orphan_detected` event on an in_review session is a bug.
    default:
      throw new TransitionError("in_review", event.type);
  }
}

function completingTransitions(event: SessionEvent): SessionState {
  switch (event.type) {
    case "cleanup_done":
      return "closed";
    default:
      throw new TransitionError("completing", event.type);
  }
}

/**
 * Convenience: classify how an iterator ended given the AgentRuntime's tracked
 * flags. Callers pass this directly to `applyTransition`.
 */
export function classifyIteratorEnd(flags: {
  resultReceived: boolean;
  rateLimited: boolean;
  taskInReview: boolean;
  crashed: boolean;
  transient: boolean;
}): SessionEvent {
  // Rate-limited exits are recoverable — preserve worktree even if the CLI
  // process crashed on its way out (the crash is a side-effect of the limit).
  if (flags.rateLimited) return { type: "iterator_done_rate_limited" };
  if (flags.crashed) {
    return flags.transient ? { type: "iterator_crashed_transient" } : { type: "iterator_crashed" };
  }
  if (flags.resultReceived) return { type: "iterator_done_with_result", taskInReview: flags.taskInReview };
  return { type: "iterator_done_normal" };
}
