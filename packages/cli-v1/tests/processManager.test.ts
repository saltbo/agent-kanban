// @vitest-environment node
/**
 * Tests for ProcessManager — focused on:
 *   - sendToSession() return value
 *   - tunnel.sendEvent() forwarding for all event types
 *   - tunnel.sendStatus("working") called on spawn
 *   - tunnel.sendStatus("done") called on cleanup
 *   - onCleanup invocation based on session state machine outcome
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

// ── Redirect SESSIONS_DIR to a temp path BEFORE importing session code ────────
const { tmpRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  return { tmpRoot: mkdtempSync(join(tmpdir(), "ak-pm-test-")) };
});

vi.mock("../src/paths.js", async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  const { join } = await import("node:path");
  return {
    ...mod,
    SESSIONS_DIR: join(tmpRoot, "sessions"),
  };
});

// ── Logger mock ───────────────────────────────────────────────────────────────
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── systemPrompt mock ─────────────────────────────────────────────────────────
vi.mock("../src/agent/systemPrompt.js", () => ({
  cleanupPromptFile: vi.fn(),
}));

import type { AgentClient, ApiClient } from "../src/client/index.js";
import { RuntimePool, type SpawnRequest } from "../src/daemon/runtimePool.js";
import type { TunnelClient } from "../src/daemon/tunnel.js";
import { mapSDKMessageStream } from "../src/providers/claude.js";
import type { AgentEvent, AgentHandle, AgentProvider } from "../src/providers/types.js";
import { SessionManager } from "../src/session/manager.js";
import { readSession, writeSession } from "../src/session/store.js";
import type { SessionFile } from "../src/session/types.js";

// ── Session helpers ───────────────────────────────────────────────────────────

let sm: SessionManager;

function makeWorkerSession(sessionId: string, overrides: Partial<SessionFile> = {}): SessionFile {
  return {
    type: "worker",
    agentId: "agent-1",
    sessionId,
    runtime: "claude" as any,
    startedAt: Date.now(),
    apiUrl: "http://localhost",
    privateKeyJwk: { kty: "OKP" } as JsonWebKey,
    taskId: "task-1",
    workspace: { type: "temp", cwd: "/tmp/x" },
    status: "active",
    ...overrides,
  };
}

// ── Minimal fakes ─────────────────────────────────────────────────────────────

function makeTunnel(): TunnelClient & { sendEvent: Mock; sendStatus: Mock } {
  return {
    sendEvent: vi.fn(),
    sendStatus: vi.fn(),
    sendHistory: vi.fn(),
    onHumanMessage: vi.fn(),
    onHistoryRequest: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: true,
  } as unknown as TunnelClient & { sendEvent: Mock; sendStatus: Mock };
}

function makeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getTask: vi.fn().mockResolvedValue({ status: "in_progress" }),
    releaseTask: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ApiClient;
}

function makeAgentClient(agentId = "agent-1", sessionId = "session-1", taskStatus = "in_progress"): AgentClient {
  return {
    getAgentId: () => agentId,
    getSessionId: () => sessionId,
    getTask: vi.fn().mockResolvedValue({ status: taskStatus }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    updateSessionUsage: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentClient;
}

function makeHandle(events: AgentEvent[] = [], opts: Partial<AgentHandle> = {}): AgentHandle {
  return {
    events: (async function* () {
      for (const e of events) yield e;
    })(),
    abort: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    ...opts,
  };
}

function makeProvider(handle: AgentHandle): AgentProvider {
  return {
    name: "claude" as any,
    label: "Claude",
    execute: vi.fn().mockResolvedValue(handle),
  };
}

function makeSpawnRequest(overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  const handle = makeHandle();
  return {
    provider: makeProvider(handle),
    taskId: "task-1",
    sessionId: "session-1",
    cwd: "/tmp",
    taskContext: "do the thing",
    agentClient: makeAgentClient(),
    agentEnv: {},
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    onSlotFreed: vi.fn(),
    onRateLimited: vi.fn(),
    onRateLimitResumed: vi.fn(),
  };
}

function makePoolCallbacks(cbs = makeCallbacks()) {
  return { onSlotFreed: cbs.onSlotFreed };
}

function makeRateLimitSink(cbs = makeCallbacks()) {
  return { onRateLimited: cbs.onRateLimited, onRateLimitResumed: cbs.onRateLimitResumed };
}

function makePool(client: ApiClient, cbs = makeCallbacks(), timeoutMs = 0, tunnel?: TunnelClient) {
  return new RuntimePool(client, makePoolCallbacks(cbs), makeRateLimitSink(cbs), timeoutMs, tunnel);
}

// ── Helper: wait for all microtasks / promises to settle ──────────────────────
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  sm = new SessionManager();
  sm._resetForTest();
});

afterEach(() => {
  rmSync(join(tmpRoot, "sessions"), { recursive: true, force: true });
});

// ── sendToSession() ────────────────────────────────────────────────────────────

describe("ProcessManager.sendToSession()", () => {
  it("returns false when no agent matches the given sessionId", async () => {
    const pm = makePool(makeApiClient(), makeCallbacks());
    const result = await pm.sendToSession("nonexistent", "hello");
    expect(result).toBe(false);
  });

  it("returns true when an agent with the matching sessionId exists", async () => {
    const tunnel = makeTunnel();
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(neverHandle);
    const agentClient = makeAgentClient("agent-1", "session-abc");
    const apiClient = makeApiClient();
    const pm = makePool(apiClient, makeCallbacks(), 0, tunnel);

    writeSession(makeWorkerSession("session-abc", { taskId: "task-1" }));

    await pm.spawnAgent({
      provider,
      taskId: "task-1",
      sessionId: "session-abc",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
    });

    const result = await pm.sendToSession("session-abc", "hello");
    resolveAbort?.();
    expect(result).toBe(true);
  });

  it("calls handle.send with the message when sessionId matches", async () => {
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const provider = makeProvider(neverHandle);
    const agentClient = makeAgentClient("agent-1", "session-xyz");
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("session-xyz", { taskId: "task-2" }));

    await pm.spawnAgent({
      provider,
      taskId: "task-2",
      sessionId: "session-xyz",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
    });

    await pm.sendToSession("session-xyz", "my message");
    resolveAbort?.();
    expect(neverHandle.send).toHaveBeenCalledWith("my message");
  });
});

// ── tunnel.sendStatus("working") on spawn ─────────────────────────────────────

describe("ProcessManager — tunnel.sendStatus on spawn", () => {
  it("calls tunnel.sendStatus with working after agent is spawned", async () => {
    const tunnel = makeTunnel();
    const handle = makeHandle();
    const provider = makeProvider(handle);
    const agentClient = makeAgentClient("a1", "sess-1");
    const pm = makePool(makeApiClient(), makeCallbacks(), 0, tunnel);

    writeSession(makeWorkerSession("sess-1", { taskId: "task-1" }));

    await pm.spawnAgent({
      provider,
      taskId: "task-1",
      sessionId: "sess-1",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
    });

    expect(tunnel.sendStatus).toHaveBeenCalledWith("sess-1", "working");
  });

  it("does not call tunnel.sendStatus when no tunnel is provided", async () => {
    const handle = makeHandle();
    const provider = makeProvider(handle);
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("sess-notunnel", { taskId: "task-notunnel" }));

    await expect(
      pm.spawnAgent({
        provider,
        taskId: "task-notunnel",
        sessionId: "sess-notunnel",
        cwd: "/tmp",
        taskContext: "ctx",
        agentClient: makeAgentClient(),
        agentEnv: {},
      }),
    ).resolves.toBeUndefined();
  });
});

// ── tunnel.sendStatus("done") on cleanup ─────────────────────────────────────

describe("ProcessManager — tunnel.sendStatus on cleanup", () => {
  it("calls tunnel.sendStatus with done when agent finishes and cleanup runs", async () => {
    const tunnel = makeTunnel();
    const handle = makeHandle([]); // empty events — completes immediately
    const provider = makeProvider(handle);
    const agentClient = makeAgentClient("a1", "sess-done");
    // getTask returns "cancelled" so taskInReview=false → completing path → runCleanup
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    const callbacks = makeCallbacks();
    const onCleanup = vi.fn();
    const pm = makePool(apiClient, callbacks, 0, tunnel);

    writeSession(makeWorkerSession("sess-done", { taskId: "task-cleanup" }));

    await pm.spawnAgent({
      provider,
      taskId: "task-cleanup",
      sessionId: "sess-done",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(tunnel.sendStatus).toHaveBeenCalledWith("sess-done", "done");
  });
});

// ── tunnel.sendEvent() for all event types ────────────────────────────────────

describe("ProcessManager — tunnel.sendEvent() forwarding", () => {
  async function spawnWithEvents(events: AgentEvent[], tunnel: TunnelClient, sessionId = "sess-ev", taskId = "task-ev"): Promise<void> {
    const handle = makeHandle(events);
    const provider = makeProvider(handle);
    const agentClient = makeAgentClient("a1", sessionId);
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    const pm = makePool(apiClient, makeCallbacks(), 0, tunnel);

    writeSession(makeWorkerSession(sessionId, { taskId }));

    await pm.spawnAgent({
      provider,
      taskId,
      sessionId,
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();
  }

  it("forwards assistant event to tunnel", async () => {
    const tunnel = makeTunnel();
    const event: AgentEvent = { type: "message", blocks: [{ type: "text", text: "hello" }] };
    await spawnWithEvents([event], tunnel, "sess-ev-1", "task-ev-1");
    expect(tunnel.sendEvent).toHaveBeenCalledWith("sess-ev-1", event);
  });

  it("forwards rate_limit event to tunnel", async () => {
    const tunnel = makeTunnel();
    const event: AgentEvent = { type: "turn.rate_limit", status: "rejected", resetAt: "2025-01-01T00:00:00Z" };
    await spawnWithEvents([event], tunnel, "sess-ev-2", "task-ev-2");
    expect(tunnel.sendEvent).toHaveBeenCalledWith("sess-ev-2", event);
  });

  it("forwards error event to tunnel", async () => {
    const tunnel = makeTunnel();
    const event: AgentEvent = { type: "error", detail: "something broke" };
    await spawnWithEvents([event], tunnel, "sess-ev-3", "task-ev-3");
    expect(tunnel.sendEvent).toHaveBeenCalledWith("sess-ev-3", event);
  });

  it("forwards result event to tunnel", async () => {
    const tunnel = makeTunnel();
    const event: AgentEvent = { type: "turn.end", cost: 0.0012 };
    await spawnWithEvents([event], tunnel, "sess-ev-4", "task-ev-4");
    expect(tunnel.sendEvent).toHaveBeenCalledWith("sess-ev-4", event);
  });

  it("does not throw when tunnel is not provided and events arrive", async () => {
    const handle = makeHandle([{ type: "error", detail: "x" }]);
    const provider = makeProvider(handle);
    const pm = makePool(makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "cancelled" }) }), makeCallbacks());

    writeSession(makeWorkerSession("sess-no-tunnel", { taskId: "task-no-tunnel" }));

    await expect(
      pm.spawnAgent({
        provider,
        taskId: "task-no-tunnel",
        sessionId: "sess-no-tunnel",
        cwd: "/tmp",
        taskContext: "ctx",
        agentClient: makeAgentClient(),
        agentEnv: {},
      }),
    ).resolves.toBeUndefined();

    await flushPromises();
    await flushPromises();
  });
});

// ── activeCount / hasTask / getActiveTaskIds ──────────────────────────────────

describe("ProcessManager — activeCount / hasTask / getActiveTaskIds", () => {
  it("activeCount returns 0 when no agents are running", () => {
    const pm = makePool(makeApiClient(), makeCallbacks());
    expect(pm.activeCount).toBe(0);
  });

  it("hasTask returns false when task is not running", () => {
    const pm = makePool(makeApiClient(), makeCallbacks());
    expect(pm.hasTask("nonexistent")).toBe(false);
  });

  it("activeCount and hasTask reflect a running agent", async () => {
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("sess-active", { taskId: "task-active" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(neverHandle), taskId: "task-active", sessionId: "sess-active" }));

    expect(pm.activeCount).toBe(1);
    expect(pm.hasTask("task-active")).toBe(true);
    resolveAbort?.();
  });

  it("getActiveTaskIds returns ids of all running agents", async () => {
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("sess-xyz", { taskId: "task-xyz" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(neverHandle), taskId: "task-xyz", sessionId: "sess-xyz" }));

    expect(pm.getActiveTaskIds()).toContain("task-xyz");
    resolveAbort?.();
  });
});

// ── sendToAgent() ─────────────────────────────────────────────────────────────

describe("ProcessManager — sendToAgent()", () => {
  it("does nothing when the taskId does not exist", async () => {
    const pm = makePool(makeApiClient(), makeCallbacks());
    await expect(pm.sendToAgent("nonexistent", "msg")).resolves.toBeUndefined();
  });

  it("delivers the message to the matching task's handle", async () => {
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("sess-msg", { taskId: "task-msg" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(neverHandle), taskId: "task-msg", sessionId: "sess-msg" }));

    await pm.sendToAgent("task-msg", "hello task");
    resolveAbort?.();
    expect(neverHandle.send).toHaveBeenCalledWith("hello task");
  });
});

// ── killTask() ────────────────────────────────────────────────────────────────

describe("ProcessManager — killTask()", () => {
  it("does nothing when the task does not exist", async () => {
    const pm = makePool(makeApiClient(), makeCallbacks());
    await expect(pm.killTask("nonexistent")).resolves.toBeUndefined();
  });

  it("aborts the handle and frees the slot", async () => {
    let resolveAbort!: () => void;
    const neverHandle: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveAbort = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveAbort?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-kill", { taskId: "task-kill" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(neverHandle), taskId: "task-kill", sessionId: "sess-kill" }));

    await pm.killTask("task-kill");

    expect(neverHandle.abort).toHaveBeenCalled();
    expect(pm.hasTask("task-kill")).toBe(false);
    expect(callbacks.onSlotFreed).toHaveBeenCalled();
  });
});

// ── killAll() ─────────────────────────────────────────────────────────────────

describe("ProcessManager — killAll()", () => {
  it("kills all running agents and frees slots", async () => {
    let resolveA!: () => void;
    let resolveB!: () => void;
    const handleA: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveA = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveA?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const handleB: AgentHandle = {
      events: (async function* () {
        await new Promise<void>((r) => {
          resolveB = r;
        });
      })(),
      abort: vi.fn().mockImplementation(() => {
        resolveB?.();
        return Promise.resolve();
      }),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const pm = makePool(makeApiClient(), makeCallbacks());

    writeSession(makeWorkerSession("sess-a", { taskId: "task-a" }));
    writeSession(makeWorkerSession("sess-b", { taskId: "task-b" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handleA), taskId: "task-a", sessionId: "sess-a" }));
    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handleB), taskId: "task-b", sessionId: "sess-b" }));

    await pm.killAll();

    expect(handleA.abort).toHaveBeenCalled();
    expect(handleB.abort).toHaveBeenCalled();
    expect(pm.activeCount).toBe(0);
  });
});

// ── spawnAgent — provider execute failure ─────────────────────────────────────

describe("ProcessManager — spawnAgent provider failure", () => {
  it("throws when provider.execute() throws and does not add the task to the pool", async () => {
    const apiClient = makeApiClient();
    const failingProvider: AgentProvider = {
      name: "claude" as any,
      label: "Claude",
      execute: vi.fn().mockRejectedValue(new Error("provider exploded")),
    };
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-fail", { taskId: "task-fail" }));

    await expect(pm.spawnAgent(makeSpawnRequest({ provider: failingProvider, taskId: "task-fail", sessionId: "sess-fail" }))).rejects.toThrow(
      "provider exploded",
    );

    expect(pm.hasTask("task-fail")).toBe(false);
  });
});

// ── onCrash path ──────────────────────────────────────────────────────────────

describe("ProcessManager — crash path", () => {
  it("releases the task when the event iterator throws", async () => {
    const throwingHandle: AgentHandle = {
      // biome-ignore lint/correctness/useYield: generator must throw without yielding to test crash path
      events: (async function* () {
        throw Object.assign(new Error("process crashed"), { exitCode: 1, stderr: "oom" });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };
    const apiClient = makeApiClient();
    const callbacks = makeCallbacks();
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-crash", { taskId: "task-crash" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(throwingHandle), taskId: "task-crash", sessionId: "sess-crash" }));

    await flushPromises();
    await flushPromises();

    expect(apiClient.releaseTask).toHaveBeenCalledWith("task-crash");
    expect(callbacks.onSlotFreed).toHaveBeenCalled();
  });
});

// ── handleEvent — rate_limit branching ───────────────────────────────────────

describe("ProcessManager — handleEvent rate_limit rejected", () => {
  it("calls onRateLimited when a rejected rate_limit event is received", async () => {
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const event: AgentEvent = { type: "turn.rate_limit", status: "rejected", resetAt };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl", { taskId: "task-rl" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl", sessionId: "sess-rl" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).toHaveBeenCalledWith("claude", resetAt);
  });

  it("does not call onRateLimitResumed when a rejected rate_limit event is received", async () => {
    const event: AgentEvent = { type: "turn.rate_limit", status: "rejected", resetAt: new Date(Date.now() + 3600_000).toISOString() };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-noresume", { taskId: "task-rl-no-resume" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-no-resume", sessionId: "sess-rl-noresume" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimitResumed).not.toHaveBeenCalled();
  });

  it("uses overage resetAt as pauseUntil when both main and overage are rejected and overage is later", async () => {
    const mainResetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overageResetAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const event: AgentEvent = {
      type: "turn.rate_limit",
      status: "rejected",
      resetAt: mainResetAt,
      overage: { status: "rejected", resetAt: overageResetAt },
    };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-overage", { taskId: "task-rl-overage" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-overage", sessionId: "sess-rl-overage" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).toHaveBeenCalledWith("claude", overageResetAt);
  });

  it("uses main resetAt when main is later than overage", async () => {
    const mainResetAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const overageResetAt = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();
    const event: AgentEvent = {
      type: "turn.rate_limit",
      status: "rejected",
      resetAt: mainResetAt,
      overage: { status: "rejected", resetAt: overageResetAt },
    };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-main-later", { taskId: "task-rl-main-later" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-main-later", sessionId: "sess-rl-main-later" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).toHaveBeenCalledWith("claude", mainResetAt);
  });

  it("falls back to 1-hour pauseUntil when rejected event has no resetAt", async () => {
    const before = Date.now();
    const event: AgentEvent = { type: "turn.rate_limit", status: "rejected" };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-noreset", { taskId: "task-rl-no-reset" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-no-reset", sessionId: "sess-rl-noreset" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).toHaveBeenCalledOnce();
    const pauseUntil = callbacks.onRateLimited.mock.calls[0][1] as string;
    const pauseMs = new Date(pauseUntil).getTime();
    expect(pauseMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 100);
  });
});

describe("ProcessManager — handleEvent rate_limit allowed", () => {
  it("calls onRateLimitResumed when allowed event with isUsingOverage false", async () => {
    const event: AgentEvent = { type: "turn.rate_limit", status: "allowed", isUsingOverage: false };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-cleared", { taskId: "task-rl-cleared" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-cleared", sessionId: "sess-rl-cleared" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimitResumed).toHaveBeenCalledWith("claude");
  });

  it("does not call onRateLimitResumed when allowed event with isUsingOverage true", async () => {
    const event: AgentEvent = { type: "turn.rate_limit", status: "allowed", isUsingOverage: true };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-overage-running", { taskId: "task-rl-overage-running" }));

    await pm.spawnAgent(
      makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-overage-running", sessionId: "sess-rl-overage-running" }),
    );
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimitResumed).not.toHaveBeenCalled();
  });

  it("does not call onRateLimited when allowed event is received", async () => {
    const event: AgentEvent = { type: "turn.rate_limit", status: "allowed", isUsingOverage: false };
    const handle = makeHandle([event]);
    const callbacks = makeCallbacks();
    const pm = makePool(makeApiClient(), callbacks);

    writeSession(makeWorkerSession("sess-rl-allowed", { taskId: "task-rl-allowed-no-limited" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-rl-allowed-no-limited", sessionId: "sess-rl-allowed" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).not.toHaveBeenCalled();
  });
});

describe("ProcessManager — result event does not call onRateLimitResumed", () => {
  it("does not call onRateLimitResumed when a result event is received after a rejected rate_limit", async () => {
    const rejectedEvent: AgentEvent = {
      type: "turn.rate_limit",
      status: "rejected",
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([rejectedEvent, resultEvent]);
    const callbacks = makeCallbacks();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-result-no-resume", { taskId: "task-result-no-resume" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(handle), taskId: "task-result-no-resume", sessionId: "sess-result-no-resume" }));
    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimitResumed).not.toHaveBeenCalled();
    expect(callbacks.onRateLimited).toHaveBeenCalledOnce();
  });
});

// ── Fix 2: onComplete — in_review branch skips safeCleanup ───────────────────
// The state machine drives the decision: getTask returning "in_review" causes
// taskInReview=true which routes the state machine to in_review (not completing).
// runCleanup is only called on the "completing" branch.

describe("ProcessManager — onComplete skips cleanup when session is in_review", () => {
  it("does NOT invoke onCleanup when getTask returns in_review", async () => {
    const tunnel = makeTunnel();
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([resultEvent]);
    const onCleanup = vi.fn();
    // agentClient.getTask returns in_review → taskInReview=true → state machine → in_review
    const pm = makePool(makeApiClient(), makeCallbacks(), 0, tunnel);
    writeSession(makeWorkerSession("sess-review", { taskId: "task-review" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-review",
      sessionId: "sess-review",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-review", "in_review"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(onCleanup).not.toHaveBeenCalled();
  });

  it("sends tunnel done status when getTask returns in_review", async () => {
    const tunnel = makeTunnel();
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([resultEvent]);

    const pm = makePool(makeApiClient(), makeCallbacks(), 0, tunnel);
    writeSession(makeWorkerSession("sess-review-done", { taskId: "task-review-done" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-review-done",
      sessionId: "sess-review-done",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-review-done", "in_review"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    expect(tunnel.sendStatus).toHaveBeenCalledWith("sess-review-done", "done");
  });

  it("does NOT remove the session file when getTask returns in_review", async () => {
    const tunnel = makeTunnel();
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([resultEvent]);

    const pm = makePool(makeApiClient(), makeCallbacks(), 0, tunnel);
    writeSession(makeWorkerSession("sess-review-no-remove", { taskId: "task-review-no-remove" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-review-no-remove",
      sessionId: "sess-review-no-remove",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-review-no-remove", "in_review"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    // Session file must still exist on disk (state machine landed on in_review, not terminal)
    expect(readSession("sess-review-no-remove")).not.toBeNull();
  });
});

describe("ProcessManager — onComplete normal completion invokes cleanup", () => {
  it("preserves worktree when agent finishes with result (session stays in_review)", async () => {
    const tunnel = makeTunnel();
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([resultEvent]);
    const onCleanup = vi.fn();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "done" }) });

    const pm = makePool(apiClient, makeCallbacks(), 0, tunnel);
    writeSession(makeWorkerSession("sess-normal", { taskId: "task-normal" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-normal",
      sessionId: "sess-normal",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-normal"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    // resultReceived=true → worktree preserved, cleanup deferred to daemon loop
    expect(onCleanup).not.toHaveBeenCalled();
  });

  it("session stays in in_review when agent finishes with result", async () => {
    const tunnel = makeTunnel();
    const resultEvent: AgentEvent = { type: "turn.end", cost: 0.001 };
    const handle = makeHandle([resultEvent]);
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "done" }) });

    const pm = makePool(apiClient, makeCallbacks(), 0, tunnel);
    writeSession(makeWorkerSession("sess-normal-keep", { taskId: "task-normal-keep" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-normal-keep",
      sessionId: "sess-normal-keep",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-normal-keep"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    // Session preserved for daemon loop to clean up later
    const session = readSession("sess-normal-keep");
    expect(session).not.toBeNull();
    expect(session?.status).toBe("in_review");
  });
});

// ── rate-limited iterator crash preserves worktree (no cleanup) ───────────────

describe("rate-limited iterator crash preserves worktree (no cleanup)", () => {
  it("does NOT invoke onCleanup when rate-limited iterator throws", async () => {
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rateLimitEvent: AgentEvent = { type: "turn.rate_limit", status: "rejected", resetAt };
    const turnEndEvent: AgentEvent = { type: "turn.end", cost: 0.001 };

    const handle: AgentHandle = {
      events: (async function* () {
        yield rateLimitEvent;
        yield turnEndEvent;
        throw new Error("You've hit your limit");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const onCleanup = vi.fn();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const callbacks = makeCallbacks();
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-rl-crash-1", { taskId: "task-rl-crash-1" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-rl-crash-1",
      sessionId: "sess-rl-crash-1",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-rl-crash-1", "in_progress"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(onCleanup).not.toHaveBeenCalled();
  });

  it("session lands in rate_limited state (not terminal) when iterator throws after rate limit", async () => {
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rateLimitEvent: AgentEvent = { type: "turn.rate_limit", status: "rejected", resetAt };
    const turnEndEvent: AgentEvent = { type: "turn.end", cost: 0.001 };

    const handle: AgentHandle = {
      events: (async function* () {
        yield rateLimitEvent;
        yield turnEndEvent;
        throw new Error("You've hit your limit");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-rl-crash-2", { taskId: "task-rl-crash-2" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-rl-crash-2",
      sessionId: "sess-rl-crash-2",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-rl-crash-2", "in_progress"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    const session = readSession("sess-rl-crash-2");
    expect(session).not.toBeNull();
    expect(session?.status).toBe("rate_limited");
  });

  it("DOES invoke onCleanup when non-rate-limited iterator throws (real crash)", async () => {
    const turnEndEvent: AgentEvent = { type: "turn.end", cost: 0.001 };

    const handle: AgentHandle = {
      events: (async function* () {
        yield turnEndEvent;
        throw new Error("process crashed unexpectedly");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const onCleanup = vi.fn();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-crash-no-rl", { taskId: "task-crash-no-rl" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-crash-no-rl",
      sessionId: "sess-crash-no-rl",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-crash-no-rl", "in_progress"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(onCleanup).toHaveBeenCalled();
  });
});

// ── transient API error preserves worktree (no cleanup) ──────────────────────

describe("transient API error (500) preserves worktree — no crash-loop", () => {
  it("does NOT invoke onCleanup when iterator throws SDK error with status 500", async () => {
    const handle: AgentHandle = {
      events: (async function* () {
        yield { type: "turn.end", cost: 0 } as AgentEvent;
        throw Object.assign(new Error("Internal server error"), { status: 500 });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const onCleanup = vi.fn();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const callbacks = makeCallbacks();
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-api500-1", { taskId: "task-api500-1" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-api500-1",
      sessionId: "sess-api500-1",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-api500-1", "in_progress"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(onCleanup).not.toHaveBeenCalled();
  });

  it("session lands in rate_limited state (not terminal) after API 500 crash", async () => {
    const handle: AgentHandle = {
      events: (async function* () {
        yield { type: "turn.end", cost: 0 } as AgentEvent;
        throw Object.assign(new Error("Internal server error"), { status: 500 });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-api500-2", { taskId: "task-api500-2" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-api500-2",
      sessionId: "sess-api500-2",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-api500-2", "in_progress"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    const session = readSession("sess-api500-2");
    expect(session).not.toBeNull();
    expect(session?.status).toBe("rate_limited");
  });

  it("does NOT call releaseTask for transient API 502 crash", async () => {
    const handle: AgentHandle = {
      events: (async function* () {
        yield { type: "turn.end", cost: 0 } as AgentEvent;
        throw Object.assign(new Error("Bad Gateway"), { status: 502 });
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const releaseTask = vi.fn().mockResolvedValue(undefined);
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }), releaseTask });
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-api502", { taskId: "task-api502" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-api502",
      sessionId: "sess-api502",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-api502", "in_progress"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    expect(releaseTask).not.toHaveBeenCalled();
  });

  it("DOES invoke onCleanup for non-transient crash (real bug)", async () => {
    const handle: AgentHandle = {
      events: (async function* () {
        yield { type: "turn.end", cost: 0 } as AgentEvent;
        throw new Error("Cannot read properties of undefined (reading 'foo')");
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const onCleanup = vi.fn();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, makeCallbacks());

    writeSession(makeWorkerSession("sess-real-crash", { taskId: "task-real-crash" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-real-crash",
      sessionId: "sess-real-crash",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-real-crash", "in_progress"),
      agentEnv: {},
      onCleanup,
    });

    await flushPromises();
    await flushPromises();

    expect(onCleanup).toHaveBeenCalled();
  });
});

// ── duplicate rate-limit deduplication via mapSDKMessageStream ────────────────

describe("duplicate rate-limit signal deduplication through mapSDKMessageStream", () => {
  it("calls onRateLimited exactly once when SDK emits both rate_limit_event and assistant error:rate_limit", async () => {
    const realResetEpoch = Math.floor(Date.now() / 1000) + 420; // 7 minutes from now

    const sdkMessages = [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: realResetEpoch,
          rateLimitType: "daily",
          isUsingOverage: false,
          overageStatus: null,
          overageResetsAt: null,
        },
      },
      {
        type: "assistant",
        error: "rate_limit",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0,
        usage: {},
      },
    ];

    const handle: AgentHandle = {
      events: (async function* () {
        const turnOpen = { value: false };
        const rateLimitSeen = { value: false };
        for (const msg of sdkMessages) {
          yield* mapSDKMessageStream(msg as any, turnOpen, rateLimitSeen);
        }
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const callbacks = makeCallbacks();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-rl-dedup-1", { taskId: "task-rl-dedup-1" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-rl-dedup-1",
      sessionId: "sess-rl-dedup-1",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-rl-dedup-1", "in_progress"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    expect(callbacks.onRateLimited).toHaveBeenCalledTimes(1);
  });

  it("passes the real API reset time (not 60-min fallback) to onRateLimited", async () => {
    const realResetEpoch = Math.floor(Date.now() / 1000) + 420; // 7 minutes from now
    const expectedResetAt = new Date(realResetEpoch * 1000).toISOString();

    const sdkMessages = [
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: realResetEpoch,
          rateLimitType: "daily",
          isUsingOverage: false,
          overageStatus: null,
          overageResetsAt: null,
        },
      },
      {
        type: "assistant",
        error: "rate_limit",
        message: { role: "assistant", content: [] },
        parent_tool_use_id: null,
      },
      {
        type: "result",
        subtype: "success",
        result: "",
        total_cost_usd: 0,
        usage: {},
      },
    ];

    const handle: AgentHandle = {
      events: (async function* () {
        const turnOpen = { value: false };
        const rateLimitSeen = { value: false };
        for (const msg of sdkMessages) {
          yield* mapSDKMessageStream(msg as any, turnOpen, rateLimitSeen);
        }
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const callbacks = makeCallbacks();
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "in_progress" }) });
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-rl-dedup-2", { taskId: "task-rl-dedup-2" }));

    await pm.spawnAgent({
      provider: makeProvider(handle),
      taskId: "task-rl-dedup-2",
      sessionId: "sess-rl-dedup-2",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient: makeAgentClient("a1", "sess-rl-dedup-2", "in_progress"),
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    const [[_taskId, resetAt]] = callbacks.onRateLimited.mock.calls;
    expect(resetAt).toBe(expectedResetAt);
  });
});

// ── clearTimer path — agent finishes before timeout fires ─────────────────────

describe("ProcessManager — clearTimer path (agent with timeout)", () => {
  it("clears the timeout when the agent finishes before the timeout fires", async () => {
    const handle = makeHandle([]); // empty events — completes immediately
    const provider = makeProvider(handle);
    const agentClient = makeAgentClient("a1", "sess-timeout-clear");
    const apiClient = makeApiClient({ getTask: vi.fn().mockResolvedValue({ status: "cancelled" }) });
    const callbacks = makeCallbacks();

    // Pass a large timeout (10 minutes) — it should be cleared when agent finishes
    const pm = makePool(apiClient, callbacks, 10 * 60 * 1000);

    writeSession(makeWorkerSession("sess-timeout-clear", { taskId: "task-timeout-clear" }));

    await pm.spawnAgent({
      provider,
      taskId: "task-timeout-clear",
      sessionId: "sess-timeout-clear",
      cwd: "/tmp",
      taskContext: "ctx",
      agentClient,
      agentEnv: {},
    });

    await flushPromises();
    await flushPromises();

    // If the timer was not cleared the slot wouldn't have been freed — just check slot was freed
    expect(callbacks.onSlotFreed).toHaveBeenCalled();
  });
});

// ── runtimePool errMessage — crash error that is not an Error instance ────────

describe("ProcessManager — crash with non-Error thrown value", () => {
  it("handles a thrown string (non-Error) from the event iterator without crashing", async () => {
    const throwingHandle: AgentHandle = {
      // biome-ignore lint/correctness/useYield: generator must throw without yielding
      events: (async function* () {
        throw "fatal string error";
      })(),
      abort: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    const apiClient = makeApiClient();
    const callbacks = makeCallbacks();
    const pm = makePool(apiClient, callbacks);

    writeSession(makeWorkerSession("sess-str-crash", { taskId: "task-str-crash" }));

    await pm.spawnAgent(makeSpawnRequest({ provider: makeProvider(throwingHandle), taskId: "task-str-crash", sessionId: "sess-str-crash" }));

    await flushPromises();
    await flushPromises();

    // Slot should be freed even when the thrown value is not an Error
    expect(callbacks.onSlotFreed).toHaveBeenCalled();
  });
});
