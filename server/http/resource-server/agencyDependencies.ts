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
    user: { tenantId: principal.tenantId, subjectId: principal.subjectId },
    scopes: storedProjectId ? scopes : [...scopes, "projects:read", "projects:write"],
  });
  const projectId =
    storedProjectId ??
    (await ensureAgencyProject(binding, createAgencyClient(origin, { token, traceparent: c.get("traceparent") }), principal.tenantId));
  return { projectId, token, origin };
}

export async function userAgencyDependencies(
  env: Env,
  user: { tenantId: string; subjectId: string },
  scopes: readonly string[],
  traceparent?: string,
) {
  const origin = requiredAgencyOrigin(env);
  const projectId = await new D1AgencyProjectBindingAdapter(env.DB).findProjectId(user.tenantId);
  if (!projectId) throw new EnborApiError(undefined, "The Task tenant has no Enbor Project binding", null);
  const token = await delegatedAgencyToken(env, { user, scopes });
  return { projectId, client: createAgencyClient(origin, { token, projectId, traceparent }) };
}

export function requiredAgencyOrigin(env: Env): string {
  if (!env.AGENCY_ORIGIN) throw new EnborApiError(undefined, "AGENCY_ORIGIN is required", null);
  return env.AGENCY_ORIGIN;
}
