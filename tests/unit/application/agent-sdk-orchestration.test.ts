import { type Agent, EnborApiError, type EnborClient, type Identity } from "@realmroot/enbor-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgencyAgent } from "../../../server/usecases/agents/projectAgents";

const identity = { metadata: { uid: "identity-1" }, status: { descriptor: { agentId: "realmroot-1" } } } as Identity;
const agent = { metadata: { uid: "agent-1" } } as Agent;
const trigger = { status: { subscription: { phase: "active" } } };

function harness() {
  const createIdentity = vi.fn().mockResolvedValue(identity);
  const deleteIdentity = vi.fn().mockResolvedValue(undefined);
  const createAgent = vi.fn().mockResolvedValue(agent);
  const createTrigger = vi.fn().mockResolvedValue(trigger);
  const client = {
    identities: { create: createIdentity, delete: deleteIdentity },
    agents: { create: createAgent },
    triggers: { create: createTrigger },
  } as unknown as EnborClient;
  return { client, createIdentity, deleteIdentity, createAgent, createTrigger };
}

const permissions = { grant: vi.fn().mockResolvedValue(undefined), deleteIdentity: vi.fn().mockResolvedValue(undefined) };

const input = {
  name: "Backend",
  description: "Builds APIs",
  username: "backend",
  runtime: "codex" as const,
  systemPrompt: "Build reliable APIs",
  provider: "openai",
  model: "gpt-5.6",
  skills: ["agent-kanban"],
  idempotencyKey: "agent-create-key",
};

describe("Agent SDK orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions.grant.mockResolvedValue(undefined);
    permissions.deleteIdentity.mockResolvedValue(undefined);
  });
  it("[spec: agents/create-bound-agent] rolls back both identities when GitHub is not connected, without creating an Agent", async () => {
    const { client, createIdentity, createAgent, deleteIdentity } = harness();
    permissions.grant.mockRejectedValueOnce(new Error("Connect GitHub first"));
    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).rejects.toThrow("Connect GitHub first");
    expect(createAgent).not.toHaveBeenCalled();
    expect(deleteIdentity).toHaveBeenCalledWith("identity-1");
    expect(permissions.deleteIdentity).toHaveBeenCalledWith("realmroot-1");
    expect(createIdentity.mock.invocationCallOrder[0]).toBeLessThan(permissions.grant.mock.invocationCallOrder[0]!);
    expect(deleteIdentity.mock.invocationCallOrder[0]).toBeLessThan(permissions.deleteIdentity.mock.invocationCallOrder[0]!);
  });
  it("[spec: agents/create-bound-agent] surfaces both the permission failure and cleanup failure without deleting a possibly bound Realmroot identity", async () => {
    const { client, createAgent, deleteIdentity } = harness();
    permissions.grant.mockRejectedValueOnce(new Error("Connect GitHub first"));
    deleteIdentity.mockRejectedValueOnce(new Error("Identity is in use"));
    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).rejects.toMatchObject({
      identityId: "identity-1",
      realmrootAgentId: "realmroot-1",
      message: expect.stringContaining("Identity is in use"),
      cause: expect.objectContaining({ message: "Connect GitHub first" }),
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(permissions.deleteIdentity).not.toHaveBeenCalled();
  });

  it("[spec: agents/create-bound-agent] reports Realmroot cleanup failure after local identity deletion", async () => {
    const { client, createAgent, deleteIdentity } = harness();
    permissions.grant.mockRejectedValueOnce(new Error("Missing GitHub scopes"));
    permissions.deleteIdentity.mockRejectedValueOnce(new Error("Realmroot unavailable"));
    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).rejects.toMatchObject({
      identityId: "identity-1",
      realmrootAgentId: "realmroot-1",
      cleanupCause: expect.objectContaining({ message: "Realmroot unavailable" }),
    });
    expect(deleteIdentity).toHaveBeenCalledWith("identity-1");
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("[spec: agents/create-bound-agent] creates the SDK Identity before the bound SDK Agent", async () => {
    const { client, createIdentity, deleteIdentity, createAgent, createTrigger } = harness();

    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).resolves.toBe(agent);
    expect(createIdentity).toHaveBeenCalledWith(
      { metadata: { name: "Backend" }, spec: { username: "backend", runtime: "codex" } },
      expect.stringMatching(/^ak-[a-f0-9]{64}$/),
    );
    expect(createAgent).toHaveBeenCalledWith(
      {
        metadata: { name: "Backend", description: "Builds APIs" },
        spec: {
          systemPrompt: "Build reliable APIs",
          provider: "openai",
          model: "gpt-5.6",
          skills: ["agent-kanban", "saltbo/agent-kanban@agent-kanban"],
          identityRef: "identity-1",
        },
      },
      expect.stringMatching(/^ak-[a-f0-9]{64}$/),
    );
    expect(permissions.grant.mock.invocationCallOrder[0]).toBeLessThan(createAgent.mock.invocationCallOrder[0]!);
    expect(createTrigger).not.toHaveBeenCalled();
    expect(createIdentity.mock.calls[0]![1]).not.toBe(createAgent.mock.calls[0]![1]);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });

  it("[spec: agents/create-bound-agent] deletes the created Identity when SDK Agent creation is permanently rejected", async () => {
    const { client, createAgent, deleteIdentity } = harness();
    const rejection = new EnborApiError(422, "invalid Agent", { type: "validation" });
    createAgent.mockRejectedValue(rejection);

    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).rejects.toBe(rejection);
    expect(deleteIdentity).toHaveBeenCalledWith("identity-1");
    expect(permissions.deleteIdentity).toHaveBeenCalledWith("realmroot-1");
  });

  it.each([
    ["network failure", new Error("network unavailable")],
    ["unknown SDK failure", new EnborApiError(undefined, "network unavailable", null)],
    ["HTTP 408", new EnborApiError(408, "request timeout", null)],
    ["HTTP 429", new EnborApiError(429, "rate limited", null)],
    ["HTTP 503", new EnborApiError(503, "upstream unavailable", null)],
    ["malformed HTTP 200", new EnborApiError(200, "invalid response", null)],
  ])("preserves the Identity after a transient %s", async (_scenario, rejection) => {
    const { client, createAgent, deleteIdentity } = harness();
    createAgent.mockRejectedValue(rejection);

    await expect(createAgencyAgent(client, input, permissions, "https://github.test/api")).rejects.toBe(rejection);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });
});
