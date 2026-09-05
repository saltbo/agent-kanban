import { describe, expect, it } from "vitest";
import { taskWorkflowActor } from "../../../server/http/tasks/workflowSupport";

describe("taskWorkflowActor", () => {
  it.each([
    ["human", undefined, "human-subject", "human", "human-subject"],
    ["agent", "agent-actor", "controller-subject", "agent", "agent-actor"],
    ["machine", "machine-actor", "machine-subject", "machine", "machine-subject"],
    ["service", "service-actor", "service-subject", "service", "service-subject"],
  ] as const)("preserves a %s principal as the workflow audit actor", (type, actorId, subjectId, actorType, expectedId) => {
    const values = { principal: { type, actorId, subjectId } };
    const context = {
      get(key: keyof typeof values) {
        return values[key];
      },
    } as Parameters<typeof taskWorkflowActor>[0];

    expect(taskWorkflowActor(context)).toEqual({ type: actorType, id: expectedId });
  });
});
