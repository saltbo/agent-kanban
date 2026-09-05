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
  it("serves interactive API documentation for the canonical OpenAPI document", async () => {
    const docs = await api.request("/api/docs", {}, env);
    const openapi = await api.request("/api/openapi.json", {}, env);

    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const html = await docs.text();
    expect(html).toContain("Agent Kanban API Docs");
    expect(html).toContain("/api/openapi.json");
    expect((await api.request("/api/docs/openapi.json", {}, env)).status).toBe(404);

    expect(openapi.status).toBe(200);
    expect(openapi.headers.get("content-type")).toContain("application/json");
    await expect(openapi.json()).resolves.toMatchObject({
      openapi: "3.1.0",
      info: { title: "Agent Kanban API" },
    });
  });

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

  it("[spec: resource-server/workflow-commands] publishes only the Task wait command name", async () => {
    const response = await api.request("/api/openapi.json", {}, env);
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const commands = Object.values(document.paths)
      .flatMap((path) => Object.values(path))
      .filter((operation) => operation && typeof operation === "object" && "x-cli-name" in operation)
      .map((operation) => operation["x-cli-name"])
      .sort();

    expect(commands).toEqual(["wait"]);
  });
});
