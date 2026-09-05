import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { machineDetailRepresentation, machineRepresentation } from "@server/http/machines/representation";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { agencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { externalPageResponse, readExternalPage } from "@server/http/resource-server/externalPagination";
import { representationEtag } from "@server/http/resource-server/representation";
import {
  completeExternalCreation,
  externalCreationIdempotencyKey,
  rejectRequestBody,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import { createMachine, getMachine, listMachinesPage } from "@server/usecases/machines/projectMachines";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerMachineRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/machines", authorizeScope("machine:read"), async (c) => {
    const page = await readExternalPage(c);
    if (page instanceof Response) return page;
    const { client } = await agencyDependencies(c, ["environments:read", "runners:read"]);
    const result = await listMachinesPage(client, { limit: page.pageSize, cursor: page.sourceCursor });
    return externalPageResponse(
      c,
      result.items.map((machine) => machineRepresentation(machine, c.req.url)),
      result.nextCursor,
    );
  });

  api.post("/api/machines", authorizeScope("machine:write"), idempotencyMiddleware, async (c) => {
    const bodyError = await rejectRequestBody(c, "Machine");
    if (bodyError) return bodyError;
    const { client, projectId } = await agencyDependencies(c, ["environments:write"]);
    const idempotencyKey = externalCreationIdempotencyKey(c);
    const result = await createMachine(client, projectId, idempotencyKey, (project, environment) => runnerStartCommand(c.env, project, environment));
    const response = {
      machine: machineRepresentation(result.machine, c.req.url),
      authCommand: runnerAuthCommand(c.env),
      startCommand: result.setup.command,
    };
    const machineEtag = await representationEtag(response.machine);
    await completeExternalCreation(c, "machines", result.machine.environment.metadata.uid, machineEtag.slice(1, -1), response);
    setCreatedResourceHeaders(c, "machines", result.machine.environment.metadata.uid, machineEtag.slice(1, -1));
    return c.json(response, 201);
  });

  api.get("/api/machines/:machineId", authorizeScope("machine:read"), async (c) => {
    const { client, projectId } = await agencyDependencies(c, ["environments:read", "runners:read"]);
    const machine = await getMachine(client, c.req.param("machineId")!);
    if (!machine) throw new HTTPException(404, { message: "Machine not found" });
    const represented = {
      ...machineDetailRepresentation(machine, c.req.url),
      authCommand: runnerAuthCommand(c.env),
      startCommand: runnerStartCommand(c.env, projectId, machine.environment.metadata.uid),
    };
    c.header("ETag", await representationEtag(represented));
    return c.json(represented);
  });

  api.delete("/api/machines/:machineId", authorizeScope("machine:write"), async (c) => {
    const { client } = await agencyDependencies(c, ["environments:write"]);
    await client.environments.delete(c.req.param("machineId")!);
    return c.body(null, 204);
  });
}

function runnerAuthCommand(env: Env): string {
  return `enbor-runner auth login --api-server ${quote(required(env.AGENCY_ORIGIN, "AGENCY_ORIGIN"))}`;
}

function runnerStartCommand(env: Env, projectId: string, environmentId: string): string {
  return `enbor-runner start --api-server ${quote(required(env.AGENCY_ORIGIN, "AGENCY_ORIGIN"))} --project-id ${quote(projectId)} --environment-id ${quote(environmentId)} --allow-unsafe-process`;
}

function quote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new HTTPException(503, { message: `${name} is required` });
  return value.replace(/\/$/, "");
}
