// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";

const env = {
  OIDC_ISSUER: "https://id.realmroot.dev/api/auth",
  AK_PUBLIC_ORIGIN: "https://agent-kanban.test",
} as Env;

async function document() {
  const response = await api.request("/api/openapi.json", {}, env);
  expect(response.status).toBe(200);
  return (await response.json()) as { paths: Record<string, any>; components: { schemas: Record<string, any> } };
}

describe("Agent and Machine projection HTTP contract", () => {
  it("[spec: agents/authoritative-projection] publishes safe Agent list and detail projections with subject", async () => {
    const openapi = await document();
    expect(openapi.paths["/agents"].get.security).toContainEqual({ realmroot: ["agent:read"] });
    expect(openapi.paths["/agents/{agentId}"].get.security).toContainEqual({ realmroot: ["agent:read"] });
    expect(openapi.paths["/agents"].get.parameters.find((parameter: any) => parameter.name === "runtime")?.schema).toEqual({
      type: "string",
      enum: ["ama", "claude-code", "codex", "copilot"],
    });
    expect(openapi.components.schemas.Agent).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["id", "name", "runtime", "subject", "schedulable", "links"]),
    });
    for (const field of ["projectId", "identityId", "credentialRef", "providerSecret"]) {
      expect(openapi.components.schemas.Agent.properties).not.toHaveProperty(field);
    }
  });

  it("[spec: agents/assignment-subject] keeps Assignment as an opaque Realmroot subject contract", async () => {
    const openapi = await document();
    expect(openapi.components.schemas.TaskAssignmentWrite).toMatchObject({
      additionalProperties: false,
      required: ["agentActorId"],
      properties: { agentActorId: { type: "string" } },
    });
    expect(openapi.components.schemas.TaskAssignmentWrite.properties).not.toHaveProperty("agentId");
  });

  it("[spec: machines/environment-projection] publishes Machine list/detail and Environment archival", async () => {
    const openapi = await document();
    expect(openapi.paths["/machines"].get.security).toContainEqual({ realmroot: ["machine:read"] });
    expect(openapi.paths["/machines"].post.security).toContainEqual({ realmroot: ["machine:write"] });
    expect(openapi.paths["/machines/{machineId}"].get.security).toContainEqual({ realmroot: ["machine:read"] });
    expect(openapi.paths["/machines/{machineId}"].delete.security).toContainEqual({ realmroot: ["machine:write"] });
    expect(openapi.components.schemas.Machine).toMatchObject({ type: "object", additionalProperties: false });
    expect(openapi.components.schemas.MachineCreateResult.required).toEqual(expect.arrayContaining(["machine", "authCommand", "startCommand"]));
  });
});
