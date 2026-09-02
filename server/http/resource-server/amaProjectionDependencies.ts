import { AmaResourceProjectionAdapter } from "@server/adapters/agency/resourceProjections";
import { D1AmaProjectBindingAdapter } from "@server/adapters/d1/amaProjectBinding";
import { delegatedAmaToken } from "@server/adapters/realmroot/delegatedAmaToken";
import type { Env } from "@server/env";
import { AmaProjectionError } from "@server/usecases/ama/failures";
import type { Context } from "hono";

export async function amaProjectionDependencies(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const authorization = await amaAuthorization(c, scopes);
  return {
    projectId: authorization.projectId,
    adapter: new AmaResourceProjectionAdapter(c.env, authorization.token, c.get("traceparent")),
  };
}

export async function amaAuthorization(c: Context<{ Bindings: Env }>, scopes: readonly string[]) {
  const principal = c.get("principal");
  const binding = new D1AmaProjectBindingAdapter(c.env.DB);
  const storedProjectId = await binding.findProjectId(principal.tenantId);
  if (!storedProjectId) throw new AmaProjectionError("unavailable", "AMA Project binding is unavailable");
  const token = await delegatedAmaToken(c.env, {
    sourceAccessToken: principal.sourceAccessToken,
    webSessionId: c.get("session")?.id,
    scopes,
  });
  return { projectId: storedProjectId, token };
}
