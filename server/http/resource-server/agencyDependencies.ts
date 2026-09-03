import { EnborApiError } from "@realmroot/enbor-sdk";
import { createAgencyClient } from "@server/adapters/agency/client";
import { D1AgencyProjectBindingAdapter } from "@server/adapters/d1/agencyProjectBinding";
import { delegatedAgencyToken } from "@server/adapters/realmroot/delegatedAgencyToken";
import type { Env } from "@server/env";
import { ensureAgencyProject } from "@server/usecases/agency/ensureAgencyProject";
import type { Context } from "hono";

export async function agencyDependencies(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const authorization = await agencyAuthorization(c, scopes);
  return {
    projectId: authorization.projectId,
    client: createAgencyClient(authorization.origin, {
      token: authorization.token,
      projectId: authorization.projectId,
      traceparent: c.get("traceparent"),
    }),
  };
}

export async function agencyAuthorization(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const origin = requiredAgencyOrigin(c.env);
  const principal = c.get("principal");
  const binding = new D1AgencyProjectBindingAdapter(c.env.DB);
  const storedProjectId = await binding.findProjectId(principal.tenantId);
  const token = await delegatedAgencyToken(c.env, {
    sourceAccessToken: principal.sourceAccessToken,
    webSessionId: c.get("session")?.id,
    scopes: storedProjectId ? scopes : [...scopes, "projects:read", "projects:write"],
  });
  const projectId =
    storedProjectId ??
    (await ensureAgencyProject(binding, createAgencyClient(origin, { token, traceparent: c.get("traceparent") }), principal.tenantId));
  return { projectId, token, origin };
}

export function requiredAgencyOrigin(env: Env): string {
  if (!env.AGENCY_ORIGIN) throw new EnborApiError(undefined, "AGENCY_ORIGIN is required", null);
  return env.AGENCY_ORIGIN;
}
