// @vitest-environment node

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loginWithRealmroot: vi.fn(),
  clearRealmrootAuthority: vi.fn(),
  getCredentials: vi.fn(() => ({
    apiUrl: "https://ak.example.test",
    issuer: "https://id.realmroot.dev/api/auth",
    resource: "https://ak.example.test/api",
    clientId: "ak-cli",
  })),
  fromEnv: vi.fn(async () => null as null | { getAgentId(): string; getSessionId(): string | null }),
  getRepository: vi.fn(async () => ({ id: "repo-1", url: "https://github.com/org/repo" })),
  createRepositoryGithubToken: vi.fn(async () => ({ token: "ghs_repo_token", full_name: "org/repo" })),
  configureGithubAuth: vi.fn(async () => "configured"),
}));

vi.mock("../src/nativeAuth.js", () => ({
  loginWithRealmroot: mocks.loginWithRealmroot,
  clearRealmrootAuthority: mocks.clearRealmrootAuthority,
  realmrootRequestHeaders: vi.fn(async () => ({ authorization: "DPoP test-token", dpop: "test-proof" })),
}));
vi.mock("../src/config.js", () => ({ getCredentials: mocks.getCredentials }));
vi.mock("../src/client/agent.js", () => ({ AgentClient: { fromEnv: mocks.fromEnv } }));
vi.mock("../src/client/machine.js", () => ({
  MachineClient: class {
    getRepository = mocks.getRepository;
    createRepositoryGithubToken = mocks.createRepositoryGithubToken;
  },
}));
vi.mock("../src/agent/leader.js", () => ({
  createClient: () => ({
    getRepository: mocks.getRepository,
    createRepositoryGithubToken: mocks.createRepositoryGithubToken,
  }),
}));
vi.mock("../src/commands/github.js", () => ({ configureGithubAuth: mocks.configureGithubAuth }));

const { registerAuthCommand } = await import("../src/commands/auth.js");
const { missingAuthSessionMessage } = await import("../src/auth/guidance.js");

function program(): Command {
  const value = new Command();
  value.exitOverride();
  registerAuthCommand(value);
  return value;
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AK_WORKER;
  delete process.env.AMA_WORKSPACE;
  delete process.env.AMA_WORKSPACE_HOME;
  mocks.fromEnv.mockResolvedValue(null);
  mocks.getCredentials.mockReturnValue({
    apiUrl: "https://ak.example.test",
    issuer: "https://id.realmroot.dev/api/auth",
    resource: "https://ak.example.test/api",
    clientId: "ak-cli",
  });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.AK_WORKER;
  delete process.env.AMA_WORKSPACE;
  delete process.env.AMA_WORKSPACE_HOME;
  log.mockRestore();
});

describe("ak auth Realmroot commands", () => {
  it("starts native Device Authorization with the selected AK Resource client", async () => {
    await program().parseAsync(
      ["auth", "login", "--api-url", "https://ak.example.test/", "--client-id", "ak-cli", "--issuer", "https://id.realmroot.dev/api/auth"],
      { from: "user" },
    );

    expect(mocks.loginWithRealmroot).toHaveBeenCalledWith({
      apiUrl: "https://ak.example.test/",
      clientId: "ak-cli",
      issuer: "https://id.realmroot.dev/api/auth",
    });
    expect(log).toHaveBeenCalledWith("Authenticated ak.example.test through Realmroot");
  });

  it("requires an explicit native Application client id", async () => {
    const previous = process.env.AK_REALMROOT_CLIENT_ID;
    delete process.env.AK_REALMROOT_CLIENT_ID;
    try {
      await expect(program().parseAsync(["auth", "login", "--api-url", "https://ak.example.test"], { from: "user" })).rejects.toThrow(
        "--client-id or AK_REALMROOT_CLIENT_ID is required",
      );
    } finally {
      if (previous !== undefined) process.env.AK_REALMROOT_CLIENT_ID = previous;
    }
  });

  it("deletes the current Realmroot authority from the OS keychain", async () => {
    await program().parseAsync(["auth", "logout"], { from: "user" });

    expect(mocks.clearRealmrootAuthority).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Removed AK Realmroot authority from the OS keychain");
  });

  it("reports the native issuer, resource, and AK endpoint", async () => {
    await program().parseAsync(["auth", "whoami"], { from: "user" });

    expect(log).toHaveBeenCalledWith("Type:        Realmroot native client");
    expect(log).toHaveBeenCalledWith("Issuer:      https://id.realmroot.dev/api/auth");
    expect(log).toHaveBeenCalledWith("Resource:    https://ak.example.test/api");
    expect(log).toHaveBeenCalledWith("API:         https://ak.example.test");
  });

  it("reports an injected AK Agent Session without reading native credentials", async () => {
    mocks.fromEnv.mockResolvedValue({ getAgentId: () => "rr-agent-1", getSessionId: () => "session-1" });

    await program().parseAsync(["auth", "whoami"], { from: "user" });

    expect(mocks.getCredentials).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("Type:        AK Agent Session");
    expect(log).toHaveBeenCalledWith("Agent ID:    rr-agent-1");
    expect(log).toHaveBeenCalledWith("Session ID:  session-1");
  });

  it("guides Agent runtimes to an AK-managed Ed25519 Session instead of Realmroot Agent enrollment", () => {
    expect(missingAuthSessionMessage()).toContain(
      "Agent runtimes receive an AK-managed Ed25519 Session through AK_AGENT_KEY, AK_AGENT_ID, AK_SESSION_ID, and AK_API_URL.",
    );
    expect(missingAuthSessionMessage()).not.toContain("REALMROOT_STATE_DIR");
  });
});

describe("ak auth git", () => {
  it("prints a short-lived GitHub App repository token", async () => {
    await program().parseAsync(["auth", "git", "repo-1", "--print-token"], { from: "user" });

    expect(mocks.getRepository).toHaveBeenCalledWith("repo-1");
    expect(mocks.createRepositoryGithubToken).toHaveBeenCalledWith("repo-1");
    expect(mocks.configureGithubAuth).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("ghs_repo_token");
  });

  it("configures GitHub only inside an isolated AK worker home", async () => {
    process.env.AK_WORKER = "1";
    process.env.AMA_WORKSPACE_HOME = "/tmp/ak-worker-home";

    await program().parseAsync(["auth", "git", "repo-1"], { from: "user" });

    expect(mocks.configureGithubAuth).toHaveBeenCalledWith("ghs_repo_token", { homeDir: "/tmp/ak-worker-home" });
    expect(log).toHaveBeenCalledWith("Configured GitHub auth for org/repo; gh credentials configured");
  });
});
