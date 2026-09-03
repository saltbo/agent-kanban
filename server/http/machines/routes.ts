import type { Env } from "@server/env";
import { machineDetailRepresentation, machineRepresentation } from "@server/http/machines/representation";
import { amaProjectionDependencies } from "@server/http/resource-server/amaProjectionDependencies";
import { externalPageResponse, readExternalPage } from "@server/http/resource-server/externalPagination";
import { representationEtag } from "@server/http/resource-server/representation";
import {
  completeExternalCreation,
  externalCreationIdempotencyKey,
  rejectRequestBody,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import {
  archiveProjectedMachine,
  createProjectedMachine,
  getProjectedMachine,
  listProjectedMachinesPage,
} from "@server/usecases/machines/projectMachines";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerMachineRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/machines", async (c) => {
    const page = await readExternalPage(c);
    if (page instanceof Response) return page;
    const { adapter, projectId } = await amaProjectionDependencies(c, ["environments:read", "runners:read"]);
    const result = await listProjectedMachinesPage(adapter, projectId, { limit: page.pageSize, cursor: page.sourceCursor });
    return externalPageResponse(
      c,
      result.items.map((machine) => machineRepresentation(machine, c.req.url)),
      result.nextCursor,
    );
  });

  api.post("/api/machines", async (c) => {
    const bodyError = await rejectRequestBody(c, "Machine");
    if (bodyError) return bodyError;
    const { adapter, projectId } = await amaProjectionDependencies(c, ["environments:write"]);
    const idempotencyKey = externalCreationIdempotencyKey(c);
    const result = await createProjectedMachine(adapter, projectId, idempotencyKey, (project, environment) =>
      runnerStartCommand(c.env, project, environment),
    );
    const response = {
      machine: machineRepresentation(result.machine, c.req.url),
      authCommand: runnerAuthCommand(c.env),
      startCommand: result.setup.command,
    };
    const machineEtag = await representationEtag(response.machine);
    await completeExternalCreation(c, "machines", result.machine.id, machineEtag.slice(1, -1), response);
    setCreatedResourceHeaders(c, "machines", result.machine.id, machineEtag.slice(1, -1));
    return c.json(response, 201);
  });

  api.get("/api/machines/:machineId", async (c) => {
    const { adapter, projectId } = await amaProjectionDependencies(c, ["environments:read", "runners:read"]);
    const machine = await getProjectedMachine(adapter, projectId, c.req.param("machineId"));
    if (!machine) throw new HTTPException(404, { message: "Machine not found" });
    const represented = {
      ...machineDetailRepresentation(machine, c.req.url),
      authCommand: runnerAuthCommand(c.env),
      startCommand: runnerStartCommand(c.env, projectId, machine.id),
    };
    c.header("ETag", await representationEtag(represented));
    return c.json(represented);
  });

  api.delete("/api/machines/:machineId", async (c) => {
    const { adapter, projectId } = await amaProjectionDependencies(c, ["environments:write"]);
    if (!(await archiveProjectedMachine(adapter, projectId, c.req.param("machineId")))) {
      throw new HTTPException(404, { message: "Machine not found" });
    }
    return c.body(null, 204);
  });
}

function runnerAuthCommand(env: Env): string {
  return `ama-runner auth login --api-server ${quote(required(env.AMA_ORIGIN, "AMA_ORIGIN"))}`;
}

function runnerStartCommand(env: Env, projectId: string, environmentId: string): string {
  return `ama-runner start --api-server ${quote(required(env.AMA_ORIGIN, "AMA_ORIGIN"))} --project-id ${quote(projectId)} --environment-id ${quote(environmentId)} --allow-unsafe-process`;
}

function quote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new HTTPException(503, { message: `${name} is required` });
  return value.replace(/\/$/, "");
}
