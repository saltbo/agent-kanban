// @vitest-environment node
/**
 * Tests for dispatcher.ts GPG path handling — gpgEnvPath() and the GNUPGHOME
 * value buildAgentEnv() hands to spawned agents.
 *
 * Git for Windows ships an MSYS build of gpg that resolves Windows-style
 * GNUPGHOME values as relative paths. gpgEnvPath() detects that build via
 * `gpgconf --list-dirs bindir` (mocked here through node:child_process) and
 * converts `C:\...` to `/c/...` only in that case. The detection result is
 * cached at module scope, so each test re-imports a fresh dispatcher module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock child_process before any imports touch it ────────────────────────────
const mockExecFileSync = vi.fn<[string, string[], object], string>();

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── config mock (buildAgentEnv reads apiUrl) ─────────────────────────────────
vi.mock("../src/config.js", () => ({
  getCredentials: () => ({ apiUrl: "https://api.example.com", apiKey: "test-key" }),
}));

// ── shared mock ───────────────────────────────────────────────────────────────
vi.mock("@agent-kanban/shared", () => ({
  isBoardType: vi.fn().mockReturnValue(true),
}));

// ── modules pulled in by dispatcher that are irrelevant to these tests ────────
vi.mock("../src/providers/registry.js", () => ({
  getAvailableProviders: vi.fn().mockReturnValue([]),
  getProvider: vi.fn(),
  normalizeRuntime: vi.fn((r: string) => r),
}));
vi.mock("../src/session/manager.js", () => ({
  getSessionManager: vi.fn(),
}));
vi.mock("../src/agent/systemPrompt.js", () => ({
  generateSystemPrompt: vi.fn(),
  writePromptFile: vi.fn(),
}));
vi.mock("../src/workspace/agents.js", () => ({
  ensureSubagents: vi.fn(),
}));
vi.mock("../src/workspace/skills.js", () => ({
  ensureSkills: vi.fn(),
}));
vi.mock("../src/workspace/repoOps.js", () => ({
  ensureCloned: vi.fn(),
  prepareRepo: vi.fn(),
  repoDir: vi.fn(),
}));
vi.mock("../src/workspace/workspace.js", () => ({
  createRepoWorkspace: vi.fn(),
  createTempWorkspace: vi.fn(),
}));

// ── Platform pinning ──────────────────────────────────────────────────────────

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Fresh dispatcher module — resets the cached MSYS-gpg detection result. */
async function freshDispatcher() {
  vi.resetModules();
  return await import("../src/daemon/dispatcher.js");
}

function mockGpgconfBindir(bindir: string) {
  mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "gpgconf" && args[0] === "--list-dirs") return `${bindir}\n`;
    throw new Error(`Unexpected execFileSync call: ${cmd} ${args.join(" ")}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setPlatform(realPlatform);
});

// ── gpgEnvPath ────────────────────────────────────────────────────────────────

describe("gpgEnvPath", () => {
  it("returns the path unchanged on non-Windows platforms without probing gpg", async () => {
    setPlatform("linux");
    const { gpgEnvPath } = await freshDispatcher();
    expect(gpgEnvPath("/tmp/ak-gpg-abc")).toBe("/tmp/ak-gpg-abc");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("converts Windows paths to MSYS form when gpg is an MSYS build", async () => {
    setPlatform("win32");
    mockGpgconfBindir("/usr/bin");
    const { gpgEnvPath } = await freshDispatcher();
    expect(gpgEnvPath("C:\\Users\\dev\\AppData\\Local\\Temp\\ak-gpg-abc")).toBe("/c/Users/dev/AppData/Local/Temp/ak-gpg-abc");
    expect(mockExecFileSync).toHaveBeenCalledWith("gpgconf", ["--list-dirs", "bindir"], expect.anything());
  });

  it("lowercases the drive letter and handles forward-slash input", async () => {
    setPlatform("win32");
    mockGpgconfBindir("/usr/bin");
    const { gpgEnvPath } = await freshDispatcher();
    expect(gpgEnvPath("D:/tmp/ak-gpg-xyz")).toBe("/d/tmp/ak-gpg-xyz");
  });

  it("keeps the Windows path for native gpg builds like Gpg4win", async () => {
    setPlatform("win32");
    mockGpgconfBindir("C:\\Program Files (x86)\\GnuPG\\bin");
    const { gpgEnvPath } = await freshDispatcher();
    const original = "C:\\Users\\dev\\AppData\\Local\\Temp\\ak-gpg-abc";
    expect(gpgEnvPath(original)).toBe(original);
  });

  it("caches the gpg build detection across calls", async () => {
    setPlatform("win32");
    mockGpgconfBindir("/usr/bin");
    const { gpgEnvPath } = await freshDispatcher();
    gpgEnvPath("C:\\tmp\\a");
    gpgEnvPath("C:\\tmp\\b");
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

// ── buildAgentEnv — GNUPGHOME dialect ────────────────────────────────────────

describe("buildAgentEnv — GNUPGHOME dialect", () => {
  const baseOpts = {
    agentId: "agent-1",
    sessionId: "session-1",
    privateKeyJwk: { kty: "OKP" } as JsonWebKey,
    agentName: "Dev Agent",
    agentUsername: "dev-agent",
  };

  it("hands MSYS gpg a converted GNUPGHOME on win32", async () => {
    setPlatform("win32");
    mockGpgconfBindir("/usr/bin");
    const { buildAgentEnv } = await freshDispatcher();
    const env = buildAgentEnv({ ...baseOpts, gpgSubkeyId: "SUBKEY", gnupgHome: "C:\\Users\\dev\\ak-gpg-abc" });
    expect(env.GNUPGHOME).toBe("/c/Users/dev/ak-gpg-abc");
    expect(env.GIT_CONFIG_VALUE_1).toBe("SUBKEY!");
  });

  it("passes GNUPGHOME through unchanged on POSIX", async () => {
    setPlatform("linux");
    const { buildAgentEnv } = await freshDispatcher();
    const env = buildAgentEnv({ ...baseOpts, gpgSubkeyId: "SUBKEY", gnupgHome: "/tmp/ak-gpg-abc" });
    expect(env.GNUPGHOME).toBe("/tmp/ak-gpg-abc");
  });

  it("sets no GNUPGHOME when signing data is absent", async () => {
    setPlatform("win32");
    const { buildAgentEnv } = await freshDispatcher();
    const env = buildAgentEnv({ ...baseOpts, gpgSubkeyId: null, gnupgHome: null });
    expect(env.GNUPGHOME).toBeUndefined();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
