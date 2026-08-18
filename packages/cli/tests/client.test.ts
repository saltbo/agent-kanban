// @vitest-environment node
/**
 * Tests for createClient() and AgentClient.fromEnv().
 *
 * The module has a cachedLeaderClient variable at module scope. To get a clean
 * cache state for each test, we call vi.resetModules() + dynamic re-import
 * inside every test that exercises the leader paths.
 */

import { randomUUID } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Persistent mock factories (re-applied after every resetModules) ──────────

const mockGetCredentials = vi.fn(() => ({ apiUrl: "https://api.example.com", apiKey: "test-key" }));
const mockDetectRuntime = vi.fn<[], string | null>(() => null);
const mockFindRuntimeAncestorPid = vi.fn<[string], number | null>(() => null);
const mockReadSession = vi.fn(() => null as any);
const mockFindLeaderSession = vi.fn(() => null as any);
const mockListSessions = vi.fn(() => {
  const session = mockFindLeaderSession();
  return session ? [session] : [];
});
const mockIsPidAlive = vi.fn(() => false);
const mockWriteSession = vi.fn();
const mockRemoveSession = vi.fn();
const mockLoadIdentity = vi.fn(() => null);
const mockSaveIdentity = vi.fn();
const mockRemoveIdentity = vi.fn();
// PID that is guaranteed to be dead (beyond kernel's pid_max)
const DEAD_PID = "4194304";
const mockReadFileSync = vi.fn((path: unknown, ...args: unknown[]) => {
  if (typeof path === "string" && path.endsWith("daemon.pid")) return DEAD_PID;
  if (typeof path === "string" && path.endsWith("package.json")) return JSON.stringify({ version: "0.0.0-test" });
  throw new Error(`Unexpected readFileSync call: ${path}`);
});

function registerMocks() {
  vi.mock("../src/config.js", () => ({ getCredentials: mockGetCredentials }));
  vi.mock("../src/agent/identity.js", () => ({ loadIdentity: mockLoadIdentity, saveIdentity: mockSaveIdentity, removeIdentity: mockRemoveIdentity }));
  vi.mock("../src/agent/runtime.js", () => ({ detectRuntime: mockDetectRuntime, findRuntimeAncestorPid: mockFindRuntimeAncestorPid }));
  vi.mock("../src/session/store.js", () => ({
    readSession: mockReadSession,
    findLeaderSession: mockFindLeaderSession,
    listSessions: mockListSessions,
    isPidAlive: mockIsPidAlive,
    removeSession: mockRemoveSession,
    writeSession: mockWriteSession,
  }));
  vi.mock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, existsSync: vi.fn(() => false), readFileSync: mockReadFileSync };
  });
}

registerMocks();

// ── Helpers ──────────────────────────────────────────────────────────────────

async function makePrivKeyJwk(): Promise<JsonWebKey> {
  const { privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
  return crypto.subtle.exportKey("jwk", privateKey);
}

/** Import fresh copies of leader + client (resetting module-level cache). */
async function freshClient() {
  await vi.resetModules();
  registerMocks();
  const [leader, client] = await Promise.all([import("../src/agent/leader.js"), import("../src/client/index.js")]);
  return { ...client, ...leader };
}

function stubLeaderAgent(agentId: string, runtime = "claude") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: agentId, name: "Stored Leader", fingerprint: "fp-stored", runtime, kind: "leader" }),
      headers: { get: () => null },
    }),
  );
}

function leaderAuthGuidance(runtime: string): string {
  return [
    "No AK auth session found.",
    `For a leader agent in the current ${runtime} runtime, run:`,
    "  ak auth login --leader-agent --username <username> [--name <name>]",
  ].join("\n");
}

// ── Global env cleanup ───────────────────────────────────────────────────────

function clearAkEnv() {
  delete process.env.AK_WORKER;
  delete process.env.AK_AGENT_ID;
  delete process.env.AK_SESSION_ID;
  delete process.env.AK_AGENT_KEY;
  delete process.env.AK_API_URL;
  delete process.env.AK_API_KEY;
  delete process.env.AK_MAINTAINER_ID;
  delete process.env.AK_LEADER_SESSION_ID;
}

beforeEach(() => {
  clearAkEnv();
  vi.clearAllMocks();
  // Restore defaults after clearAllMocks
  mockGetCredentials.mockReturnValue({ apiUrl: "https://api.example.com", apiKey: "test-key" });
  mockDetectRuntime.mockReturnValue(null);
  mockFindRuntimeAncestorPid.mockReturnValue(null);
  mockReadSession.mockReturnValue(null);
  mockFindLeaderSession.mockReturnValue(null);
  mockListSessions.mockImplementation(() => {
    const session = mockFindLeaderSession();
    return session ? [session] : [];
  });
  mockIsPidAlive.mockReturnValue(false);
  mockReadFileSync.mockImplementation((path: unknown) => {
    if (typeof path === "string" && path.endsWith("daemon.pid")) return DEAD_PID;
    if (typeof path === "string" && path.endsWith("package.json")) return JSON.stringify({ version: "0.0.0-test" });
    throw new Error(`Unexpected readFileSync: ${path}`);
  });
});

afterEach(() => {
  clearAkEnv();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── AgentClient.fromEnv — unit tests ─────────────────────────────────────────
// These tests import AgentClient directly (no cache concern — fromEnv has no
// module-level state).

describe("AgentClient.fromEnv", () => {
  it("returns null when AK_AGENT_ID is missing", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_AGENT_KEY = "{}";
    process.env.AK_API_URL = "https://example.com";
    expect(await AgentClient.fromEnv()).toBeNull();
  });

  it("returns null when AK_SESSION_ID is missing", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_AGENT_KEY = "{}";
    process.env.AK_API_URL = "https://example.com";
    expect(await AgentClient.fromEnv()).toBeNull();
  });

  it("returns null when AK_AGENT_KEY is missing", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_API_URL = "https://example.com";
    expect(await AgentClient.fromEnv()).toBeNull();
  });

  it("returns null when AK_API_URL is missing", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_AGENT_KEY = "{}";
    expect(await AgentClient.fromEnv()).toBeNull();
  });

  it("returns null when no AK_* env vars are present", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    expect(await AgentClient.fromEnv()).toBeNull();
  });

  it("returns an AgentClient instance when all four env vars are present with a valid key", async () => {
    const { AgentClient } = await import("../src/client/index.js");
    const privJwk = await makePrivKeyJwk();
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_AGENT_KEY = JSON.stringify(privJwk);
    process.env.AK_API_URL = "https://example.com";
    expect(await AgentClient.fromEnv()).toBeInstanceOf(AgentClient);
  });
});

describe("AgentClient JWT timestamps", () => {
  it("backdates iat by 30 seconds while exp remains 60 seconds after signing time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const { AgentClient } = await import("../src/client/index.js");
    const privateKeyJwk = await makePrivKeyJwk();
    const privateKey = await crypto.subtle.importKey("jwk", privateKeyJwk, { name: "Ed25519" } as any, false, ["sign"]);
    const client = new AgentClient("https://api.example.com", "agent-1", "session-1", privateKey);
    let authorization = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(JSON.stringify({ id: "agent-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await client.getAgent("agent-1");

    const payload = decodeJwt(authorization.replace(/^Bearer /, ""));
    const now = Math.floor(Date.now() / 1000);
    expect(payload.iat).toBe(now - 30);
    expect(payload.exp).toBe(now + 60);
  });
});

// ── createClient: daemon-spawned worker (AK_* env vars) ─────────────────────

describe("createClient — daemon-spawned worker (AK_* env vars)", () => {
  it("returns an AgentClient instance when all env vars are set", async () => {
    const { createClient, AgentClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    process.env.AK_AGENT_ID = agentId;
    process.env.AK_SESSION_ID = sessionId;
    process.env.AK_AGENT_KEY = JSON.stringify(privJwk);
    process.env.AK_API_URL = "https://api.example.com";

    const client = await createClient();
    expect(client).toBeInstanceOf(AgentClient);
  });

  it("getAgentId returns the AK_AGENT_ID value", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const agentId = randomUUID();
    process.env.AK_AGENT_ID = agentId;
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_AGENT_KEY = JSON.stringify(privJwk);
    process.env.AK_API_URL = "https://api.example.com";

    const { AgentClient } = await import("../src/client/index.js");
    const client = (await createClient()) as InstanceType<typeof AgentClient>;
    expect(client.getAgentId()).toBe(agentId);
  });

  it("getSessionId returns the AK_SESSION_ID value", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const sessionId = randomUUID();
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_SESSION_ID = sessionId;
    process.env.AK_AGENT_KEY = JSON.stringify(privJwk);
    process.env.AK_API_URL = "https://api.example.com";

    const { AgentClient } = await import("../src/client/index.js");
    const client = (await createClient()) as InstanceType<typeof AgentClient>;
    expect(client.getSessionId()).toBe(sessionId);
  });

  it("does not call detectRuntime when env vars are present", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    process.env.AK_AGENT_ID = randomUUID();
    process.env.AK_SESSION_ID = randomUUID();
    process.env.AK_AGENT_KEY = JSON.stringify(privJwk);
    process.env.AK_API_URL = "https://api.example.com";

    await createClient();
    expect(mockDetectRuntime).not.toHaveBeenCalled();
  });
});

// ── createClient: no runtime (human in terminal) ─────────────────────────────

describe("createClient — no runtime (human in terminal)", () => {
  it("throws when no env vars and no runtime is detected", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue(null);
    await expect(createClient()).rejects.toThrow();
  });

  it("error message includes generic auth guidance", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue(null);
    await expect(createClient()).rejects.toThrow(/No AK auth session found\./);
    await expect(createClient()).rejects.toThrow(/ak auth login --leader-agent/);
  });

  it("calls detectRuntime when no env vars are set", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue(null);
    await expect(createClient()).rejects.toThrow();
    expect(mockDetectRuntime).toHaveBeenCalled();
  });
});

// ── createClient: runtime detected + existing leader session found by PID ─────

describe("createClient — leader session restored from session file", () => {
  function makeStoredSession(privJwk: JsonWebKey, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      type: "leader",
      agentId: randomUUID(),
      sessionId: randomUUID(),
      pid: process.ppid,
      runtime: "claude",
      startedAt: Date.now(),
      apiUrl: "https://api.example.com",
      privateKeyJwk: privJwk,
      ...overrides,
    };
  }

  it("returns an AgentClient built from the stored session", async () => {
    const { createClient, AgentClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const session = makeStoredSession(privJwk);
    stubLeaderAgent(session.agentId as string);
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(session.pid as number);
    mockFindLeaderSession.mockReturnValue(session);
    mockIsPidAlive.mockReturnValue(true);

    const client = await createClient();
    expect(client).toBeInstanceOf(AgentClient);
  });

  it("getAgentId returns the agentId from the stored session", async () => {
    const { createClient, AgentClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const storedAgentId = randomUUID();
    const session = makeStoredSession(privJwk, { agentId: storedAgentId });
    stubLeaderAgent(storedAgentId);
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(session.pid as number);
    mockFindLeaderSession.mockReturnValue(session);
    mockIsPidAlive.mockReturnValue(true);

    const client = (await createClient()) as InstanceType<typeof AgentClient>;
    expect(client.getAgentId()).toBe(storedAgentId);
  });

  it("getSessionId returns the sessionId from the stored session", async () => {
    const { createClient, AgentClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const storedSessionId = randomUUID();
    const session = makeStoredSession(privJwk, { sessionId: storedSessionId });
    stubLeaderAgent(session.agentId as string);
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(session.pid as number);
    mockFindLeaderSession.mockReturnValue(session);
    mockIsPidAlive.mockReturnValue(true);

    const client = (await createClient()) as InstanceType<typeof AgentClient>;
    expect(client.getSessionId()).toBe(storedSessionId);
  });

  it("does not call the daemon PID file path when a stored session exists", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    const session = makeStoredSession(privJwk);
    stubLeaderAgent(session.agentId as string);
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(session.pid as number);
    mockFindLeaderSession.mockReturnValue(session);
    mockIsPidAlive.mockReturnValue(true);

    await createClient();
    // isDaemonAlive reads PID_FILE — should not be called when session is restored
    expect(mockReadFileSync.mock.calls.some(([path]) => typeof path === "string" && path.endsWith("daemon.pid"))).toBe(false);
  });
});

// ── createClient: runtime detected + no leader session ───────────────────────

describe("createClient — runtime detected without leader session", () => {
  it("throws shared leader auth guidance when runtime is detected but no session is available", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    mockFindLeaderSession.mockReturnValue(null);
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
  });

  it("error message points to auth login instead of ak start", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    mockFindLeaderSession.mockReturnValue(null);
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    await expect(createClient()).rejects.toThrow(/ak auth login --leader-agent/);
    await expect(createClient()).rejects.not.toThrow(/ak start/i);
  });

  it("preserves leader-runtime guidance when API credentials are not configured", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("codex");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    mockGetCredentials.mockImplementation(() => {
      throw new Error("No AK API environment configured");
    });

    let error: unknown;
    try {
      await createClient();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(leaderAuthGuidance("codex"));
    expect((error as Error).message).not.toContain("No AK API environment configured");
  });

  it("throws shared leader auth guidance when the PID file does not exist (readFileSync throws)", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    mockFindLeaderSession.mockReturnValue(null);
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
  });

  it("throws shared leader auth guidance when session runtime does not match current runtime", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    // Session exists but has wrong runtime
    mockFindLeaderSession.mockReturnValue({
      type: "leader",
      agentId: randomUUID(),
      sessionId: randomUUID(),
      pid: process.ppid,
      runtime: "codex", // mismatch
      startedAt: Date.now(),
      apiUrl: "https://api.example.com",
      privateKeyJwk: privJwk,
    });
    mockIsPidAlive.mockReturnValue(true);
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
  });

  it("throws shared leader auth guidance when session pid is not alive", async () => {
    const { createClient } = await freshClient();
    const privJwk = await makePrivKeyJwk();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    mockFindLeaderSession.mockReturnValue({
      type: "leader",
      agentId: randomUUID(),
      sessionId: randomUUID(),
      pid: process.ppid,
      runtime: "claude",
      startedAt: Date.now(),
      apiUrl: "https://api.example.com",
      privateKeyJwk: privJwk,
    });
    mockIsPidAlive.mockReturnValue(false); // pid is dead
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
  });

  it("throws shared leader auth guidance when findLeaderSession returns null (no matching leader session)", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(99999);
    // findLeaderSession never returns worker sessions by design; null means no leader cached
    mockFindLeaderSession.mockReturnValue(null);
    mockIsPidAlive.mockReturnValue(false); // daemon not running
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
  });
});

// ── AgentClient: authorize() and API method coverage ────────────────────────
// These tests construct an AgentClient directly and make API calls through a
// mocked fetch to cover the authorize() JWT path and a sampling of API methods.

describe("AgentClient — authorize and messaging methods", () => {
  async function makeAgentClient() {
    const { AgentClient } = await import("../src/client/index.js");
    const { privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
    return new AgentClient("https://api.example.com", randomUUID(), randomUUID(), privateKey);
  }

  function stubFetchOk(body: unknown = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        headers: { get: () => null },
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("authorize produces a Bearer JWT string", async () => {
    const client = await makeAgentClient();
    stubFetchOk([]);
    // Trigger authorize indirectly by calling any API method
    await client.listAgents();
    const [, opts] = (vi.mocked(fetch) as any).mock.calls[0];
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
  });

  it("sendMessage posts to the messages endpoint", async () => {
    const client = await makeAgentClient();
    stubFetchOk({});
    await client.sendMessage("task-1", { sender_type: "agent", sender_id: "aid", content: "hello" });
    const [url, opts] = (vi.mocked(fetch) as any).mock.calls[0];
    expect(url).toContain("/api/tasks/task-1/messages");
    expect(opts.method).toBe("POST");
  });

  it("getMessages calls the messages endpoint with no query string when since is absent", async () => {
    const client = await makeAgentClient();
    stubFetchOk([]);
    await client.getMessages("task-2");
    const [url] = (vi.mocked(fetch) as any).mock.calls[0];
    expect(url).toContain("/api/tasks/task-2/messages");
    expect(url).not.toContain("?");
  });

  it("getMessages appends since query parameter when provided", async () => {
    const client = await makeAgentClient();
    stubFetchOk([]);
    await client.getMessages("task-3", "2024-01-01T00:00:00Z");
    const [url] = (vi.mocked(fetch) as any).mock.calls[0];
    expect(url).toContain("since=");
  });
});

// ── Leader identity/login helpers ───────────────────────────────────────────

describe("leader identity and login helpers", () => {
  function makeMockFetch(agents: any[] = [], createdAgent: any = null, createdSession = { delegation_proof: "proof" }) {
    return vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      const path = new URL(url).pathname;
      let body: any;
      const status = 200;

      if (path === "/api/agents" && opts.method === "GET") {
        body = agents;
      } else if (path.startsWith("/api/agents/") && !path.includes("/sessions") && opts.method === "GET") {
        const agentId = path.split("/")[3];
        body = agents.find((agent) => agent.id === agentId) ?? {
          id: agentId,
          name: "Stored Leader",
          fingerprint: "fp-stored",
          runtime: "claude",
          kind: "leader",
        };
      } else if (path.includes("/sessions") && opts.method === "POST") {
        body = createdSession;
      } else if (path === "/api/agents" && opts.method === "POST") {
        body = createdAgent ?? { id: randomUUID(), name: "Custom Claude", fingerprint: "fp-abc", runtime: "claude", kind: "leader" };
      } else {
        body = {};
      }

      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        headers: { get: () => null },
      } as unknown as Response;
    });
  }

  function makeMockFetchWithMissingAgent(missingAgentId: string, agents: any[] = [], createdSession = { delegation_proof: "proof" }) {
    return vi.fn().mockImplementation(async (url: string, opts: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === `/api/agents/${missingAgentId}` && opts.method === "GET") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: "NOT_FOUND", message: "Agent not found" } }),
          headers: { get: () => null },
        } as unknown as Response;
      }
      return makeMockFetch(agents, null, createdSession)(url, opts);
    });
  }

  it("getIdentity restores identity from the server when local identity is missing", async () => {
    const { getIdentity } = await freshClient();
    const restored = { id: randomUUID(), name: "Hermes Leader", fingerprint: "fp-hermes", runtime: "hermes", kind: "leader" };
    mockLoadIdentity.mockReturnValue(null);

    const mockFetch = makeMockFetch([restored]);
    vi.stubGlobal("fetch", mockFetch);

    try {
      const identity = await getIdentity("hermes");
      expect(identity).toEqual({
        agent_id: restored.id,
        name: restored.name,
        fingerprint: restored.fingerprint,
      });
      expect(mockSaveIdentity).toHaveBeenCalledWith("hermes", identity);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("createIdentity creates and saves a leader identity with supplied username/name", async () => {
    const { createIdentity } = await freshClient();
    mockLoadIdentity.mockReturnValue(null);

    const createdAgent = { id: randomUUID(), name: "Claude Leader", fingerprint: "fp-abc", runtime: "claude", kind: "leader" };
    const mockFetch = makeMockFetch([], createdAgent);
    vi.stubGlobal("fetch", mockFetch);

    try {
      const identity = await createIdentity({ runtime: "claude", username: "claude-leader", name: "Claude Leader" });
      const createAgentCall = mockFetch.mock.calls.find(
        ([url, opts]: [string, RequestInit]) => new URL(url).pathname === "/api/agents" && opts.method === "POST",
      );
      expect(createAgentCall).toBeTruthy();
      const [, opts] = createAgentCall!;
      const body = JSON.parse(String(opts.body));
      expect(body).toMatchObject({ runtime: "claude", kind: "leader", username: "claude-leader", name: "Claude Leader" });
      expect(identity).toEqual({ agent_id: createdAgent.id, name: createdAgent.name, fingerprint: createdAgent.fingerprint });
      expect(mockSaveIdentity).toHaveBeenCalledWith("claude", identity);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("createIdentity refuses to overwrite an existing local identity", async () => {
    const { createIdentity } = await freshClient();
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "existing", fingerprint: "fp-existing" });

    await expect(createIdentity({ runtime: "claude", username: "claude-leader" })).rejects.toThrow(/already exists/);
  });

  it("loginLeaderAgent creates a leader identity and persists a leader session", async () => {
    const { loginLeaderAgent } = await freshClient();
    const createdAgent = { id: randomUUID(), name: "Claude Leader", fingerprint: "fp-abc", runtime: "claude", kind: "leader" };
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue(null);
    mockFindLeaderSession.mockReturnValue(null);
    const mockFetch = makeMockFetch([], createdAgent);
    vi.stubGlobal("fetch", mockFetch);

    try {
      const result = await loginLeaderAgent({ runtime: "claude", username: "claude-leader", name: "Claude Leader" });
      expect(result).toMatchObject({
        identity: { agent_id: createdAgent.id, name: createdAgent.name, fingerprint: createdAgent.fingerprint },
        reusedIdentity: false,
      });
      expect(mockWriteSession).toHaveBeenCalledWith(expect.objectContaining({ type: "leader", agentId: createdAgent.id, pid: 12345 }));
      expect(
        mockFetch.mock.calls.some(
          ([url, opts]: [string, RequestInit]) => new URL(url).pathname === `/api/agents/${createdAgent.id}/sessions` && opts.method === "POST",
        ),
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loginLeaderAgent reuses an existing identity and creates a leader session", async () => {
    const { loginLeaderAgent } = await freshClient();
    const agentId = randomUUID();
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue({ agent_id: agentId, name: "claude", fingerprint: "fp" });
    const mockFetch = makeMockFetch();
    vi.stubGlobal("fetch", mockFetch);

    try {
      const result = await loginLeaderAgent({ runtime: "claude", username: "ignored" });
      expect(result.reusedIdentity).toBe(true);
      expect(mockWriteSession).toHaveBeenCalledWith(expect.objectContaining({ type: "leader", agentId, pid: 12345 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loginLeaderAgent removes a stale local identity and restores the unique server leader", async () => {
    const { loginLeaderAgent } = await freshClient();
    const staleAgentId = randomUUID();
    const restored = { id: randomUUID(), name: "Restored Claude", fingerprint: "fp-restore", runtime: "claude", kind: "leader" };
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockFindLeaderSession.mockReturnValue(null);
    mockLoadIdentity.mockReturnValue({ agent_id: staleAgentId, name: "stale", fingerprint: "fp-stale" });

    const mockFetch = makeMockFetchWithMissingAgent(staleAgentId, [restored]);
    vi.stubGlobal("fetch", mockFetch);

    try {
      const result = await loginLeaderAgent({ runtime: "claude", username: "ignored" });
      expect(result.identity.agent_id).toBe(restored.id);
      expect(mockRemoveIdentity).toHaveBeenCalledWith("claude");
      expect(mockSaveIdentity).toHaveBeenCalledWith("claude", {
        agent_id: restored.id,
        name: restored.name,
        fingerprint: restored.fingerprint,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loginLeaderAgent creates a new identity when the server has multiple leader identities for the same runtime", async () => {
    const { loginLeaderAgent } = await freshClient();
    const createdAgent = { id: randomUUID(), name: "New Claude", fingerprint: "fp-new", runtime: "claude", kind: "leader" };
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockLoadIdentity.mockReturnValue(null);
    const mockFetch = makeMockFetch(
      [
        { id: randomUUID(), name: "Alex", fingerprint: "fp-1", runtime: "claude", kind: "leader" },
        { id: randomUUID(), name: "Sam", fingerprint: "fp-2", runtime: "claude", kind: "leader" },
      ],
      createdAgent,
    );
    vi.stubGlobal("fetch", mockFetch);

    try {
      const result = await loginLeaderAgent({ runtime: "claude", username: "new-claude", name: "New Claude" });
      expect(result.identity.agent_id).toBe(createdAgent.id);
      expect(result.reusedIdentity).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("createClient without a session does not bootstrap via API key", async () => {
    const { createClient } = await freshClient();
    mockDetectRuntime.mockReturnValue("claude");
    mockFindRuntimeAncestorPid.mockReturnValue(12345);
    mockFindLeaderSession.mockReturnValue(null);
    mockLoadIdentity.mockReturnValue({ agent_id: randomUUID(), name: "claude@host", fingerprint: "fp-abc" });
    const mockFetch = makeMockFetch();
    vi.stubGlobal("fetch", mockFetch);

    try {
      await expect(createClient()).rejects.toThrow(leaderAuthGuidance("claude"));
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockWriteSession).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("loginLeaderAgent throws with diagnostic message when findRuntimeAncestorPid returns null", async () => {
    const { loginLeaderAgent } = await freshClient();
    mockFindRuntimeAncestorPid.mockReturnValue(null); // no ancestor found

    await expect(loginLeaderAgent({ runtime: "claude", username: "claude-leader" })).rejects.toThrow(
      /Could not locate claude process in ancestry\. ak must be invoked from inside a claude session\./,
    );
  });
});

// ── ApiClient method stubs — route and method coverage ───────────────────────
// The ApiClient exposes many thin wrappers around request(). These tests verify
// that each method hits the correct URL and HTTP verb.

describe("ApiClient method stubs", () => {
  async function makeAgentClient() {
    const { AgentClient } = await import("../src/client/index.js");
    const { privateKey } = (await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, ["sign", "verify"])) as CryptoKeyPair;
    return new AgentClient("https://api.example.com", randomUUID(), randomUUID(), privateKey);
  }

  function stubOk(body: unknown = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => body,
        headers: { get: () => null },
      }),
    );
  }

  function lastCall(): [string, RequestInit] {
    return (vi.mocked(fetch) as any).mock.calls.at(-1);
  }

  afterEach(() => vi.unstubAllGlobals());

  it("createTask posts to /api/tasks", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.createTask({ title: "t" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks");
    expect(opts.method).toBe("POST");
  });

  it("listTasks calls GET /api/tasks with no query when params absent", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listTasks();
    const [url, opts] = lastCall();
    expect(url).toMatch(/\/api\/tasks$/);
    expect(opts.method).toBe("GET");
  });

  it("listTasks appends query string when params provided", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listTasks({ status: "todo" });
    const [url] = lastCall();
    expect(url).toContain("status=todo");
  });

  it("listAgents appends query string when params provided", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listAgents({ kind: "worker", role: "test-specialist", available: "true" });
    const [url] = lastCall();
    expect(url).toContain("/api/agents?");
    expect(url).toContain("kind=worker");
    expect(url).toContain("role=test-specialist");
    expect(url).toContain("available=true");
  });

  it("getTask calls GET /api/tasks/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.getTask("task-1");
    const [url] = lastCall();
    expect(url).toContain("/api/tasks/task-1");
  });

  it("claimTask posts to /api/tasks/:id/claim", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.claimTask("task-2");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-2/claim");
    expect(opts.method).toBe("POST");
  });

  it("completeTask posts to /api/tasks/:id/complete", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.completeTask("task-3");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-3/complete");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeUndefined();
  });

  it("updateTask patches /api/tasks/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateTask("task-4", { status: "done" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-4");
    expect(opts.method).toBe("PATCH");
  });

  it("releaseTask posts to /api/tasks/:id/release", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.releaseTask("task-5");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-5/release");
    expect(opts.method).toBe("POST");
  });

  it("cancelTask posts to /api/tasks/:id/cancel", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.cancelTask("task-6");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-6/cancel");
    expect(opts.method).toBe("POST");
  });

  it("reviewTask posts to /api/tasks/:id/review", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.reviewTask("task-7", { pr: "url" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-7/review");
    expect(opts.method).toBe("POST");
  });

  it("assignTask posts to /api/tasks/:id/assign with agent_id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.assignTask("task-8", "agent-abc");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-8/assign");
    expect(JSON.parse(opts.body as string).agent_id).toBe("agent-abc");
  });

  it("addNote posts to /api/tasks/:id/notes", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.addNote("task-9", "note text");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-9/notes");
    expect(opts.method).toBe("POST");
  });

  it("deleteTask sends DELETE to /api/tasks/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.deleteTask("task-10");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-10");
    expect(opts.method).toBe("DELETE");
  });

  it("rejectTask posts to /api/tasks/:id/reject", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.rejectTask("task-11");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-11/reject");
    expect(opts.method).toBe("POST");
  });

  it("getTaskNotes calls GET /api/tasks/:id/notes", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.getTaskNotes("task-12");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-12/notes");
    expect(opts.method).toBe("GET");
  });

  it("getTaskSession calls GET /api/tasks/:id/session", async () => {
    const c = await makeAgentClient();
    stubOk({ task_id: "task-12", session_id: "session-1", session: {} });
    await c.getTaskSession("task-12");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-12/session");
    expect(opts.method).toBe("GET");
  });

  it("getTaskSessionWs calls GET /api/tasks/:id/session/ws", async () => {
    const c = await makeAgentClient();
    stubOk({ url: "wss://session.test" });
    await c.getTaskSessionWs("task-12");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/tasks/task-12/session/ws");
    expect(opts.method).toBe("GET");
  });

  it("getSession calls GET /api/sessions/:id", async () => {
    const c = await makeAgentClient();
    stubOk({ session_id: "session-1", session: {} });
    await c.getSession("session-1");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/sessions/session-1");
    expect(opts.method).toBe("GET");
  });

  it("getSessionWs calls GET /api/sessions/:id/ws", async () => {
    const c = await makeAgentClient();
    stubOk({ url: "wss://session.test" });
    await c.getSessionWs("session-1");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/sessions/session-1/ws");
    expect(opts.method).toBe("GET");
  });

  it("getTaskNotes appends since query when provided", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.getTaskNotes("task-13", "2024-01-01T00:00:00Z");
    const [url] = lastCall();
    expect(url).toContain("since=");
  });

  it("getAgent calls GET /api/agents/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.getAgent("agent-1");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-1");
    expect(opts.method).toBe("GET");
  });

  it("getAgentGpgKey calls GET /api/agents/:id/gpg-key", async () => {
    const c = await makeAgentClient();
    stubOk({ armored_private_key: "key", gpg_subkey_id: null });
    await c.getAgentGpgKey("agent-2");
    const [url] = lastCall();
    expect(url).toContain("/api/agents/agent-2/gpg-key");
  });

  it("updateAgent patches /api/agents/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateAgent("agent-3", { name: "new" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-3");
    expect(opts.method).toBe("PATCH");
  });

  it("deleteAgent sends DELETE /api/agents/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.deleteAgent("agent-4");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-4");
    expect(opts.method).toBe("DELETE");
  });

  it("registerMachine posts to /api/machines", async () => {
    const c = await makeAgentClient();
    stubOk({ id: "m1", name: "my-machine" });
    await c.registerMachine({
      name: "box",
      os: "linux",
      version: "1.0",
      runtimes: [{ name: "claude", status: "ready", checked_at: "2026-03-21T10:00:00Z" }],
      device_id: "dev-1",
    });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/machines");
    expect(opts.method).toBe("POST");
  });

  it("getMachine calls GET /api/machines/:id", async () => {
    const c = await makeAgentClient();
    stubOk({ id: "m1", name: "box" });
    await c.getMachine("machine-42");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/machines/machine-42");
    expect(opts.method).toBe("GET");
  });

  it("heartbeat posts to /api/machines/:id/heartbeat", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.heartbeat("machine-1", {});
    const [url, opts] = lastCall();
    expect(url).toContain("/api/machines/machine-1/heartbeat");
    expect(opts.method).toBe("POST");
  });

  it("closeSession sends DELETE to the session endpoint", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.closeSession("agent-1", "sess-1");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-1/sessions/sess-1");
    expect(opts.method).toBe("DELETE");
  });

  it("reopenSession posts to the session reopen endpoint", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.reopenSession("agent-1", "sess-2");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-1/sessions/sess-2/reopen");
    expect(opts.method).toBe("POST");
  });

  it("listSessions calls GET /api/agents/:id/sessions", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listSessions("agent-5");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-5/sessions");
    expect(opts.method).toBe("GET");
  });

  it("createBoard posts to /api/boards", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.createBoard({ name: "b", type: "dev" as any });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards");
    expect(opts.method).toBe("POST");
  });

  it("listBoards calls GET /api/boards", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listBoards();
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards");
    expect(opts.method).toBe("GET");
  });

  it("getBoardByName encodes the name in the query string", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.getBoardByName("my board");
    const [url] = lastCall();
    expect(url).toContain("name=my%20board");
  });

  it("getBoard calls GET /api/boards/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.getBoard("board-1");
    const [url] = lastCall();
    expect(url).toContain("/api/boards/board-1");
  });

  it("updateBoard patches /api/boards/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateBoard("board-2", { name: "new" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards/board-2");
    expect(opts.method).toBe("PATCH");
  });

  it("deleteBoard sends DELETE /api/boards/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.deleteBoard("board-3");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards/board-3");
    expect(opts.method).toBe("DELETE");
  });

  it("createRepository posts to /api/repositories", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.createRepository({ name: "repo", url: "https://github.com/x/y" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/repositories");
    expect(opts.method).toBe("POST");
  });

  it("listRepositories calls GET /api/repositories", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listRepositories();
    const [url, opts] = lastCall();
    expect(url).toContain("/api/repositories");
    expect(opts.method).toBe("GET");
  });

  it("listRepositories appends url filter when provided", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listRepositories({ url: "https://github.com/x/y" });
    const [url] = lastCall();
    expect(url).toContain("url=");
  });

  it("listRepositories appends board filter when provided", async () => {
    const c = await makeAgentClient();
    stubOk([]);
    await c.listRepositories({ board_id: "board-1" });
    const [url] = lastCall();
    expect(url).toContain("board_id=board-1");
  });

  it("getRepository calls GET /api/repositories/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.getRepository("repo-1");
    const [url] = lastCall();
    expect(url).toContain("/api/repositories/repo-1");
  });

  it("createRepositoryGithubToken posts to /api/repositories/:id/github-token", async () => {
    const c = await makeAgentClient();
    stubOk({ token: "ghs_test" });
    await c.createRepositoryGithubToken("repo-1");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/repositories/repo-1/github-token");
    expect(opts.method).toBe("POST");
  });

  it("deleteRepository sends DELETE /api/repositories/:id", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.deleteRepository("repo-2");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/repositories/repo-2");
    expect(opts.method).toBe("DELETE");
  });

  it("updateSessionUsage patches the session usage endpoint", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateSessionUsage("agent-1", "sess-1", {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      cost_micro_usd: 200,
    });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/agents/agent-1/sessions/sess-1/usage");
    expect(opts.method).toBe("PATCH");
  });

  it("throws ApiError when response status is not ok", async () => {
    const { ApiError } = await import("../src/client/index.js");
    const c = await makeAgentClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: "not found" } }),
        headers: { get: () => null },
      }),
    );
    await expect(c.getTask("missing")).rejects.toBeInstanceOf(ApiError);
  });

  it("ApiError carries the HTTP status code", async () => {
    const { ApiError } = await import("../src/client/index.js");
    const c = await makeAgentClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({}),
        headers: { get: () => null },
      }),
    );
    try {
      await c.getTask("x");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).status).toBe(403);
    }
  });

  it("includes Retry-After in the error message for 429 responses", async () => {
    const c = await makeAgentClient();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({}),
        headers: { get: (h: string) => (h === "Retry-After" ? "60" : null) },
      }),
    );
    await expect(c.getTask("x")).rejects.toThrow(/retry after 60s/i);
  });

  it.each(
    (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"] as const).flatMap((code) => (["code", "cause.code"] as const).map((shape) => ({ code, shape }))),
  )("retries $code from $shape exactly once and returns the second success", async ({ code, shape }) => {
    const c = await makeAgentClient();
    const retryable = shape === "code" ? Object.assign(new Error(code), { code }) : Object.assign(new Error(code), { cause: { code } });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}), headers: { get: () => null } });
    vi.stubGlobal("fetch", fetchMock);

    await c.getTask("retry-task");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(
    (["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"] as const).flatMap((code) => (["code", "cause.code"] as const).map((shape) => ({ code, shape }))),
  )("passes through the second failure after retrying $code from $shape once", async ({ code, shape }) => {
    const c = await makeAgentClient();
    const retryable = shape === "code" ? Object.assign(new Error(code), { code }) : Object.assign(new Error(code), { cause: { code } });
    const secondFailure = new Error(`second failure after ${code}`);
    const fetchMock = vi.fn().mockRejectedValueOnce(retryable).mockRejectedValueOnce(secondFailure);
    vi.stubGlobal("fetch", fetchMock);

    await expect(c.getTask("retry-task")).rejects.toBe(secondFailure);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["code", "cause.code"] as const)("does not replay createTask POST for UND_ERR_SOCKET from %s", async (shape) => {
    const c = await makeAgentClient();
    const staleSocket =
      shape === "code"
        ? Object.assign(new Error("stale socket"), { code: "UND_ERR_SOCKET" })
        : Object.assign(new Error("stale socket"), { cause: { code: "UND_ERR_SOCKET" } });
    const fetchMock = vi.fn().mockRejectedValue(staleSocket);
    vi.stubGlobal("fetch", fetchMock);

    await expect(c.createTask({ title: "must not duplicate" })).rejects.toBe(staleSocket);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it.each([
    ["ordinary error", new Error("ordinary failure")],
    ["direct timeout code", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })],
    ["nested Undici timeout code", Object.assign(new Error("fetch timed out"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })],
  ])("does not retry a non-retryable %s", async (_label, error) => {
    const c = await makeAgentClient();
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);

    await expect(c.getTask("x")).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("updateBoardMaintainer sends PATCH /api/boards/:boardId/maintainers/:maintainerId", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateBoardMaintainer("board-abc", "maintainer-xyz", { status: "paused" });
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards/board-abc/maintainers/maintainer-xyz");
    expect(opts.method).toBe("PATCH");
  });

  it("updateBoardMaintainer sends the input body as JSON", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.updateBoardMaintainer("board-abc", "maintainer-xyz", { name: "Nightly", interval_seconds: 86400, heartbeat_enabled: false });
    const [, opts] = lastCall();
    expect(JSON.parse(opts.body as string)).toEqual({ name: "Nightly", interval_seconds: 86400, heartbeat_enabled: false });
  });

  it("deleteBoardMaintainer sends DELETE /api/boards/:boardId/maintainers/:maintainerId", async () => {
    const c = await makeAgentClient();
    stubOk({});
    await c.deleteBoardMaintainer("board-def", "maintainer-uvw");
    const [url, opts] = lastCall();
    expect(url).toContain("/api/boards/board-def/maintainers/maintainer-uvw");
    expect(opts.method).toBe("DELETE");
  });
});
