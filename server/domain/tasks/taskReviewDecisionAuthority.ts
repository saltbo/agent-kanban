export type TaskReviewDecisionActor = { type: "agent"; id: string } | { type: "human"; id: string } | { type: "system"; id: string };

export type TaskReviewDecisionAuthority = "allowed" | "unsupported-assignee" | "self-review";

export function taskReviewDecisionAuthority(
  assigneeIdentityType: string | null,
  assignedTo: string | null,
  actor: TaskReviewDecisionActor,
): TaskReviewDecisionAuthority {
  if (assigneeIdentityType !== "realmroot_actor" || !assignedTo) return "unsupported-assignee";
  if (actor.type === "agent" && actor.id === assignedTo) return "self-review";
  return "allowed";
}
