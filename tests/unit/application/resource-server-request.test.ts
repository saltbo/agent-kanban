import { describe, expect, it } from "vitest";
import { resolveActor } from "../../../server/http/resource-server/request";

describe("resolveActor", () => {
  it.each([
    ["human", undefined, "human-subject", "user", "human-subject"],
    ["agent", "agent-actor", "controller-subject", "realmroot:agent", "agent-actor"],
    ["machine", "machine-actor", "machine-subject", "machine", "machine-actor"],
    ["service", undefined, "service-subject", "service", "service-subject"],
  ] as const)("preserves a %s principal as the canonical Task actor", (type, actorId, subjectId, actorType, expectedActorId) => {
    const context = contextWith({ principal: { type, actorId, subjectId } });

    expect(resolveActor(context)).toEqual({ actorType, actorId: expectedActorId, sessionId: null });
  });
});

function contextWith(values: Record<string, unknown>): Parameters<typeof resolveActor>[0] {
  return {
    get(key: string) {
      return values[key];
    },
  } as Parameters<typeof resolveActor>[0];
}
