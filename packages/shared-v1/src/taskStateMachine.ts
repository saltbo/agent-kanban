import type { TaskStatus } from "./types.js";

export type IdentityType = "user" | "machine" | "agent:worker" | "agent:leader" | "agent:maintainer";

export type TaskTransition =
  | "claim" // todo → in_progress
  | "review" // in_progress → in_review
  | "reject" // in_review → in_progress
  | "complete" // in_review → done
  | "cancel" // todo|in_progress|in_review → cancelled
  | "release"; // in_progress → todo (machine only, stale timeout)

interface TransitionDef {
  from: TaskStatus[];
  to: TaskStatus;
  allow: IdentityType[];
}

const TRANSITIONS: Record<TaskTransition, TransitionDef> = {
  claim: { from: ["todo"], to: "in_progress", allow: ["agent:worker"] },
  review: { from: ["in_progress"], to: "in_review", allow: ["agent:worker"] },
  reject: { from: ["in_review"], to: "in_progress", allow: ["user", "agent:leader", "agent:maintainer"] },
  complete: { from: ["in_review"], to: "done", allow: ["user", "machine", "agent:leader", "agent:maintainer"] },
  // todo is cancellable too: an assigned todo task keeps getting re-dispatched
  // by the sweep, so cancel must be able to stop it before any agent claims it.
  cancel: { from: ["todo", "in_progress", "in_review"], to: "cancelled", allow: ["user", "machine", "agent:leader", "agent:maintainer"] },
  release: { from: ["in_progress"], to: "todo", allow: ["machine", "agent:leader", "agent:maintainer"] },
};

export interface TransitionError {
  code: "INVALID_TRANSITION" | "FORBIDDEN";
  message: string;
}

export function validateTransition(action: TaskTransition, currentStatus: TaskStatus, identity: IdentityType): TransitionError | null {
  const def = TRANSITIONS[action];
  if (!def) return { code: "INVALID_TRANSITION", message: `Unknown action: ${action}` };

  if (!def.allow.includes(identity)) {
    return { code: "FORBIDDEN", message: `${identity} cannot perform ${action}` };
  }

  if (!def.from.includes(currentStatus)) {
    return {
      code: "INVALID_TRANSITION",
      message: `Cannot ${action} from ${currentStatus} (allowed from: ${def.from.join(", ")})`,
    };
  }

  return null;
}

export function getTargetStatus(action: TaskTransition): TaskStatus {
  return TRANSITIONS[action].to;
}

export function getAllowedActions(currentStatus: TaskStatus, identity: IdentityType): TaskTransition[] {
  return (Object.keys(TRANSITIONS) as TaskTransition[]).filter((action) => {
    const def = TRANSITIONS[action];
    return def.from.includes(currentStatus) && def.allow.includes(identity);
  });
}
