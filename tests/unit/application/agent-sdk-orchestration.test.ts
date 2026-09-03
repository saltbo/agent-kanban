import { type Agent, EnborApiError, type EnborClient, type Identity } from "@realmroot/enbor-sdk";
import { describe, expect, it, vi } from "vitest";
import { createAgencyAgent } from "../../../server/usecases/agents/projectAgents";

const identity = { metadata: { uid: "identity-1" } } as Identity;
const agent = { metadata: { uid: "agent-1" } } as Agent;

function harness() {
  const createIdentity = vi.fn().mockResolvedValue(identity);
  const deleteIdentity = vi.fn().mockResolvedValue(undefined);
  const createAgent = vi.fn().mockResolvedValue(agent);
  const client = {
    identities: { create: createIdentity, delete: deleteIdentity },
    agents: { create: createAgent },
  } as unknown as EnborClient;
  return { client, createIdentity, deleteIdentity, createAgent };
}

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
  it("[spec: agents/create-bound-agent] creates the SDK Identity before the bound SDK Agent", async () => {
    const { client, createIdentity, deleteIdentity, createAgent } = harness();

    await expect(createAgencyAgent(client, input)).resolves.toBe(agent);
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
          skills: ["agent-kanban"],
          identityRef: "identity-1",
        },
      },
      expect.stringMatching(/^ak-[a-f0-9]{64}$/),
    );
    expect(createIdentity.mock.calls[0]![1]).not.toBe(createAgent.mock.calls[0]![1]);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });

  it("[spec: agents/create-bound-agent] deletes the created Identity when SDK Agent creation is permanently rejected", async () => {
    const { client, createAgent, deleteIdentity } = harness();
    const rejection = new EnborApiError(422, "invalid Agent", { type: "validation" });
    createAgent.mockRejectedValue(rejection);

    await expect(createAgencyAgent(client, input)).rejects.toBe(rejection);
    expect(deleteIdentity).toHaveBeenCalledWith("identity-1");
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

    await expect(createAgencyAgent(client, input)).rejects.toBe(rejection);
    expect(deleteIdentity).not.toHaveBeenCalled();
  });
});
