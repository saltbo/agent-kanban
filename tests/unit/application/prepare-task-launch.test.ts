import type { Agent } from "@realmroot/enbor-sdk";
import { prepareTaskLaunch } from "@server/usecases/tasks/prepareTaskLaunch";
import { describe, expect, it, vi } from "vitest";

const lease = {
  id: "launch-1",
  task_id: "task-1",
  owner_id: "tenant-1",
  assignee_actor_id: "actor-1",
  repository_id: "repo-1",
  repository_url: "https://github.com/example/source",
  lease_token: "lease-1",
  lease_expires_at: "2030-01-01T00:00:00Z",
  attempts: 1,
};
const agent = {
  metadata: { uid: "enbor-agent-1", projectId: "project-1" },
  spec: { identity: { issuer: "https://identity.test", subject: "actor-1" } },
} as Agent;

function fixture() {
  const list = vi.fn().mockResolvedValue({ data: [agent], pagination: { nextCursor: null } });
  const prepareWorkspace = vi.fn().mockResolvedValue({
    url: "https://github.com/example/source.git",
    ref: "main",
    mountPath: "/workspace/repos/github.com/example/source",
    secretRef: "enbor://vaults/vault-1/credentials/credential-1",
  });
  return {
    list,
    prepareWorkspace,
    input: {
      lease,
      projectId: "project-1",
      issuer: "https://identity.test",
      publicOrigin: "https://agent-kanban.test",
      client: { agents: { list } },
      prepareWorkspace,
    },
  };
}

describe("Task Session request preparation", () => {
  it("[spec: tasks/prepare-launch] binds the exact Agent identity and uses only a Git volume secretRef", async () => {
    const { input } = fixture();
    const prepared = await prepareTaskLaunch(input);
    expect(prepared.request.spec).toEqual({
      agentId: "enbor-agent-1",
      volumes: [
        {
          name: "task-repository",
          type: "git_repository",
          url: "https://github.com/example/source.git",
          ref: "main",
          secretRef: "enbor://vaults/vault-1/credentials/credential-1",
        },
      ],
      volumeMounts: [{ name: "task-repository", mountPath: "/workspace/repos/github.com/example/source" }],
    });
    expect(prepared.request.metadata?.labels?.["agent-kanban.dev/launch-id"]).toBe("launch-1");
    expect(prepared.request.prompt).toContain("create its Claim");
    expect(prepared.request.prompt).toContain("own Realmroot Agent identity");
  });
  it.each(["wrong issuer", "wrong subject", "ambiguous identity", "wrong Project"])(
    "[spec: tasks/prepare-launch] rejects %s before creating repository credentials",
    async (scenario) => {
      const { input, list, prepareWorkspace } = fixture();
      const identity = { ...agent.spec.identity! };
      if (scenario === "wrong issuer") identity.issuer = "https://other.test";
      if (scenario === "wrong subject") identity.subject = "other-actor";
      const candidate = {
        ...agent,
        metadata: { ...agent.metadata, projectId: scenario === "wrong Project" ? "other-project" : "project-1" },
        spec: { ...agent.spec, identity },
      };
      list.mockResolvedValue({ data: scenario === "ambiguous identity" ? [candidate, candidate] : [candidate], pagination: { nextCursor: null } });
      await expect(prepareTaskLaunch(input)).rejects.toThrow();
      expect(prepareWorkspace).not.toHaveBeenCalled();
    },
  );
  it("[spec: tasks/prepare-launch] prepares repository-free Tasks without creating bootstrap credentials", async () => {
    const { input, prepareWorkspace } = fixture();
    const prepared = await prepareTaskLaunch({ ...input, lease: { ...lease, repository_id: null, repository_url: null } });
    expect(prepared.request.spec).toEqual({ agentId: "enbor-agent-1" });
    expect(prepareWorkspace).not.toHaveBeenCalled();
  });
});

it.each([
  ["organization-id", "organization-id"],
  ["user:controller-id", "controller-id"],
])("[spec: tasks/prepare-launch] supplies the canonical Context for owner %s", async (ownerId, contextId) => {
  const { input } = fixture();
  const result = await prepareTaskLaunch({ ...input, lease: { ...lease, owner_id: ownerId } });
  expect(result.request.prompt).toContain(`AK Context ID: ${contextId}. Use --context ${contextId}`);
  expect(result.request.prompt).not.toContain("--context user:");
});
