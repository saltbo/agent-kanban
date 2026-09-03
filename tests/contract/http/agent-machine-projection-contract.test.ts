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
  it("[spec: agents/authoritative-projection] publishes safe Agent projections with nullable identity fields", async () => {
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
      required: expect.arrayContaining(["id", "name", "username", "runtime", "subject", "schedulable", "links"]),
      properties: {
        username: { type: ["string", "null"] },
        runtime: { type: ["string", "null"] },
        subject: { type: ["string", "null"] },
      },
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

  it("[spec: machines/environment-projection] [spec: machines/create-runner-setup] publishes per-Runner usage and setup commands on Machine detail", async () => {
    const openapi = await document();
    expect(openapi.paths["/machines"].get.security).toContainEqual({ realmroot: ["machine:read"] });
    expect(openapi.paths["/machines"].post.security).toContainEqual({ realmroot: ["machine:write"] });
    expect(openapi.paths["/machines/{machineId}"].get.security).toContainEqual({ realmroot: ["machine:read"] });
    expect(openapi.paths["/machines/{machineId}"].delete.security).toContainEqual({ realmroot: ["machine:write"] });
    expect(openapi.paths["/machines"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/MachineCollection",
    });
    expect(openapi.paths["/machines/{machineId}"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/MachineDetail",
    });
    expect(openapi.components.schemas.Machine).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["runnerCount"]),
    });
    expect(openapi.components.schemas.Machine.properties).not.toHaveProperty("runners");
    expect(openapi.components.schemas.MachineDetail).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["runnerCount", "runners", "authCommand", "startCommand"]),
      properties: {
        runners: { type: "array", items: { $ref: "#/components/schemas/MachineRunner" } },
        authCommand: { type: "string" },
        startCommand: { type: "string" },
      },
    });
    expect(openapi.components.schemas.MachineRunner).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: expect.arrayContaining(["id", "name", "runtimes", "runtimeUsage"]),
      properties: { runtimeUsage: { type: "array", items: { $ref: "#/components/schemas/MachineRuntimeUsage" } } },
    });
    expect(openapi.components.schemas.MachineRuntimeUsageWindow).toMatchObject({
      required: ["label", "utilization", "resetsAt"],
      properties: { utilization: { type: "number" }, resetsAt: { type: "string", format: "date-time" } },
    });
    expect(openapi.paths["/machines"].post.requestBody).toBeUndefined();
    expect(openapi.components.schemas).not.toHaveProperty("MachineWrite");
    expect(openapi.components.schemas.MachineCreateResult.required).toEqual(expect.arrayContaining(["machine", "authCommand", "startCommand"]));
    expect(openapi.components.schemas.MachineCreateResult.properties.machine).toEqual({ $ref: "#/components/schemas/Machine" });
  });
});
