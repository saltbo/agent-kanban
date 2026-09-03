import { EnborApiError } from "@realmroot/enbor-sdk";
import { createAgencyClient } from "@server/adapters/agency/client";
import { D1AmaProjectBindingAdapter } from "@server/adapters/d1/amaProjectBinding";
import { delegatedAmaToken } from "@server/adapters/realmroot/delegatedAmaToken";
import type { Env } from "@server/env";
import { ensureAmaProject } from "@server/usecases/ama/ensureAmaProject";
import type { Context } from "hono";

export async function amaDependencies(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const authorization = await amaAuthorization(c, scopes);
  return {
    projectId: authorization.projectId,
    client: createAgencyClient(authorization.origin, {
      token: authorization.token,
      projectId: authorization.projectId,
      traceparent: c.get("traceparent"),
    }),
  };
}

export async function amaAuthorization(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const origin = requiredAmaOrigin(c.env);
  const principal = c.get("principal");
  const binding = new D1AmaProjectBindingAdapter(c.env.DB);
  const storedProjectId = await binding.findProjectId(principal.tenantId);
  const token = await delegatedAmaToken(c.env, {
    sourceAccessToken: principal.sourceAccessToken,
    webSessionId: c.get("session")?.id,
    scopes: storedProjectId ? scopes : [...scopes, "projects:read", "projects:write"],
  });
  const projectId =
    storedProjectId ??
    (await ensureAmaProject(binding, createAgencyClient(origin, { token, traceparent: c.get("traceparent") }), principal.tenantId));
  return { projectId, token, origin };
}

export function requiredAmaOrigin(env: Env): string {
  if (!env.AMA_ORIGIN) throw new EnborApiError(undefined, "AMA_ORIGIN is required", null);
  return env.AMA_ORIGIN;
}
