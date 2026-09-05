import { createAgencyClient } from "@server/adapters/agency/client";
import { taskLaunchResources } from "@server/adapters/agency/taskLaunchResources";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("rotates only the recorded Vault credential and confirms the returned active expiry", async () => {
  const expiresAt = "2030-01-01T01:00:00Z";
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(input instanceof Request ? input : new Request(input, init));
      return Response.json({ status: { phase: "active", activeVersion: { spec: { metadata: { "agent-kanban.dev/expires-at": expiresAt } } } } });
    }),
  );
  const resources = taskLaunchResources(async (_owner, projectId) => createAgencyClient("https://enbor.test", { token: "authority", projectId }));
  await resources.refreshBootstrap("tenant-1", "project-1", "enbor://vaults/vault-1/credentials/credential-1", "bootstrap-test-token", expiresAt);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0].url).pathname).toBe("/api/v1/vaults/vault-1/credentials/credential-1");
  expect(requests[0].method).toBe("PUT");
  expect(await requests[0].json()).toEqual({
    stringData: { username: "x-access-token", password: "bootstrap-test-token" },
    metadata: { "agent-kanban.dev/expires-at": expiresAt },
  });
});

it("uses the exact tenant Project, Session metadata uid, and credential identity through the SDK", async () => {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return Response.json({ metadata: { uid: "session-1", projectId: "project-1" } });
    }),
  );
  const resources = taskLaunchResources(async (ownerId, projectId) => {
    expect([ownerId, projectId]).toEqual(["tenant-1", "project-1"]);
    return createAgencyClient("https://enbor.test", { token: "tenant-token", projectId });
  });
  await expect(
    resources.create("tenant-1", { projectId: "project-1", request: { spec: { agentId: "agent-1" }, prompt: "Claim Task" } }, "launch-1"),
  ).resolves.toEqual({ uid: "session-1" });
  await resources.closeSession("tenant-1", "project-1", "session-1");
  await resources.revokeBootstrap("tenant-1", "project-1", "enbor://vaults/vault-1/credentials/credential-1");
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/api/v1/sessions",
    "/api/v1/sessions/session-1",
    "/api/v1/vaults/vault-1/credentials/credential-1",
  ]);
  expect(requests.every((request) => request.headers.get("x-enbor-project-id") === "project-1")).toBe(true);
  expect(await requests[1].json()).toEqual({ state: "closed" });
  expect(await requests[2].json()).toMatchObject({ state: "revoked" });
});

it("retains authorization failures while treating already-deleted resources as settled", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ message: "Forbidden" }, { status: 403 }));
  vi.stubGlobal("fetch", fetch);
  const resources = taskLaunchResources(async (_ownerId, projectId) =>
    createAgencyClient("https://enbor.test", { token: "tenant-token", projectId }),
  );
  await expect(resources.closeSession("tenant-1", "project-1", "session-1")).rejects.toMatchObject({ status: 403 });
  fetch.mockResolvedValue(Response.json({ message: "Not found" }, { status: 404 }));
  await expect(resources.closeSession("tenant-1", "project-1", "session-1")).resolves.toBeUndefined();
});
