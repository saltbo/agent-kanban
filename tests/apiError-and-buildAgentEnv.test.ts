// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// ApiError constructor signature: (status, message, code?)
// 2-arg: (status, message) — code defaults to HTTP_{status}
// 3-arg: (status, message, code) — code is explicitly provided
describe("ApiError — constructor", () => {
  it("2-arg form: sets status and message, code defaults to HTTP_{status}", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err.code).toBe("HTTP_404");
  });

  it("3-arg form: explicit code overrides the default", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(403, "CLI too old", "CLI_UPGRADE_REQUIRED");
    expect(err.status).toBe(403);
    expect(err.message).toBe("CLI too old");
    expect(err.code).toBe("CLI_UPGRADE_REQUIRED");
  });

  it("is an instance of Error", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    expect(new ApiError(500, "Server error")).toBeInstanceOf(Error);
  });

  it("2-arg: code reflects status code", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(429, "Too many requests");
    expect(err.code).toBe("HTTP_429");
  });

  it("3-arg: provided code is preserved exactly", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(400, "Bad input", "VALIDATION_FAILED");
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("3-arg: message is the second argument", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(401, "Unauthorized", "AUTH_ERROR");
    expect(err.message).toBe("Unauthorized");
    expect(err.code).toBe("AUTH_ERROR");
  });
});

describe("buildAgentEnv — AK_WORKER env var", () => {
  it("includes AK_WORKER=1 in the returned environment", async () => {
    vi.mock("../packages/cli/src/config.js", () => ({
      getCredentials: () => ({ apiUrl: "https://api.example.com" }),
    }));
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "agent-1",
      sessionId: "session-1",
      privateKeyJwk: { kty: "OKP", crv: "Ed25519", x: "abc" } as JsonWebKey,
      agentName: "Test Agent",
      agentUsername: "testagent",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env.AK_WORKER).toBe("1");
  });

  it("includes AK_AGENT_ID matching the provided agentId", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "my-agent-id",
      sessionId: "session-abc",
      privateKeyJwk: {} as JsonWebKey,
      agentName: "Agent",
      agentUsername: "agent",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env.AK_AGENT_ID).toBe("my-agent-id");
  });

  it("includes AK_SESSION_ID matching the provided sessionId", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "a",
      sessionId: "my-session-id",
      privateKeyJwk: {} as JsonWebKey,
      agentName: "Agent",
      agentUsername: "agent",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env.AK_SESSION_ID).toBe("my-session-id");
  });

  it("sets git author/committer name from agentName", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "a",
      sessionId: "s",
      privateKeyJwk: {} as JsonWebKey,
      agentName: "Bot McBotface",
      agentUsername: "botmcbotface",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env.GIT_AUTHOR_NAME).toBe("Bot McBotface");
    expect(env.GIT_COMMITTER_NAME).toBe("Bot McBotface");
  });

  it("does not include GNUPGHOME when gnupgHome is null", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "a",
      sessionId: "s",
      privateKeyJwk: {} as JsonWebKey,
      agentName: "Agent",
      agentUsername: "agent",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env.GNUPGHOME).toBeUndefined();
  });

  it("ignores removed automatic GPG signing inputs", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const env = buildAgentEnv({
      agentId: "a",
      sessionId: "s",
      privateKeyJwk: {} as JsonWebKey,
      agentName: "Agent",
      agentUsername: "agent",
      gpgSubkeyId: "ABCDEF01",
      gnupgHome: "/tmp/gnupg-test",
    });
    expect(env.GNUPGHOME).toBeUndefined();
    expect(Object.values(env)).not.toContain("ABCDEF01!");
  });

  it("does not expose the removed Agent JWT private key", async () => {
    const { buildAgentEnv } = await import("../packages/cli/src/daemon/dispatcher.js");
    const jwk = { kty: "OKP", crv: "Ed25519", x: "testkey" } as JsonWebKey;
    const env = buildAgentEnv({
      agentId: "a",
      sessionId: "s",
      privateKeyJwk: jwk,
      agentName: "Agent",
      agentUsername: "agent",
      gpgSubkeyId: null,
      gnupgHome: null,
    });
    expect(env).not.toHaveProperty("AK_AGENT_KEY");
  });
});
