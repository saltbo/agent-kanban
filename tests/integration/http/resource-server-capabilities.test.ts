// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";

const env = {
  OIDC_ISSUER: "https://id.realmroot.dev/api/auth",
  AK_PUBLIC_ORIGIN: "https://agent-kanban.test",
} as Env;
const resource = `${env.AK_PUBLIC_ORIGIN}/api`;

describe("Resource Server HTTP capabilities", () => {
  it("[spec: resource-server/discovery] publishes protected-resource and Toolbox discovery over HTTP", async () => {
    const metadata = await api.request("/.well-known/oauth-protected-resource/api", {}, env);
    const service = await api.request("/api", {}, env);

    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource,
      authorization_servers: [env.OIDC_ISSUER],
      dpop_bound_access_tokens_required: true,
    });
    expect(service.status).toBe(200);
    expect(service.headers.get("link")).toContain(`${resource}/openapi.json`);
    await expect(service.json()).resolves.toMatchObject({ openapi: `${resource}/openapi.json` });
    expect((await api.request("/api/toolbox/openapi.json", {}, env)).status).toBe(404);
  });

  it("[spec: resource-server/workflow-commands] publishes only the seven resource-first workflow command names", async () => {
    const response = await api.request("/api/openapi.json", {}, env);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const commands = Object.values(document.paths)
      .flatMap((path) => Object.values(path))
      .filter((operation) => operation && typeof operation === "object" && "x-cli-name" in operation)
      .map((operation) => operation["x-cli-name"])
      .sort();

    expect(commands).toEqual(["cancel", "claim", "complete", "reject", "release", "review", "wait"]);
  });
});
