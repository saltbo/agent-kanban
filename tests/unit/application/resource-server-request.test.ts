import { describe, expect, it } from "vitest";
import { resolveActor } from "../../../server/http/resource-server/request";

describe("resolveActor", () => {
  it("rejects an unsupported identity without provider branding", () => {
    const context = contextWith({ identityType: "service" });

    expect(() => resolveActor(context)).toThrow(expect.objectContaining({ status: 403, message: "User or Agent identity is required" }));
  });

  it("rejects a supported identity when its actor identifier is missing", () => {
    const context = contextWith({ identityType: "realmroot:agent" });

    expect(() => resolveActor(context)).toThrow(expect.objectContaining({ status: 403, message: "Actor identity is required" }));
  });
});

function contextWith(values: Record<string, unknown>): Parameters<typeof resolveActor>[0] {
  return {
    get(key: string) {
      return values[key];
    },
  } as Parameters<typeof resolveActor>[0];
}
