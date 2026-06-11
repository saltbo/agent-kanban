// @vitest-environment node
/**
 * Tests for runtime.ts — detectRuntime() and findRuntimeAncestorPid().
 *
 * findRuntimeAncestorPid() calls execFileSync("ps", ...) internally via the
 * private readProcess() helper. We mock node:child_process to control what
 * process ancestry looks like without spawning real `ps` processes.
 *
 * On win32 the ancestry walk is replaced by a daemon-pid anchor read from
 * PID_FILE; node:fs and session/store are mocked to control that path. The
 * host platform is pinned per test so the suite behaves identically on
 * POSIX and Windows dev machines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock child_process before any imports touch it ────────────────────────────
const mockExecFileSync = vi.fn<[string, string[], object], string>();

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

// runtime.ts reads PID_FILE via node:fs and checks it with isPidAlive on win32
const mockReadFileSync = vi.fn<[string, string], string>();

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
}));

const mockIsPidAlive = vi.fn<[number], boolean>();

vi.mock("../src/session/store.js", () => ({
  isPidAlive: mockIsPidAlive,
}));

// Import after mocks are registered
const { detectRuntime, findRuntimeAncestorPid } = await import("../src/agent/runtime.js");

// ── Platform pinning ──────────────────────────────────────────────────────────

const realPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a fake `ps -o ppid=,command=` output line. */
function psLine(ppid: number, command: string): string {
  return `  ${ppid}  ${command}`;
}

// ── Environment cleanup ───────────────────────────────────────────────────────

function clearRuntimeEnv() {
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_CI;
  delete process.env.GEMINI_CLI;
  delete process.env.COPILOT_CLI;
  delete process.env.HERMES_INTERACTIVE;
  delete process.env.HERMES_SESSION_KEY;
  delete process.env.AK_LEADER_PID;
}

beforeEach(() => {
  clearRuntimeEnv();
  vi.clearAllMocks();
  // Existing ancestry-walk tests assume a POSIX `ps`; pin the platform so
  // they pass identically on Windows dev machines. win32 tests override.
  setPlatform("linux");
});

afterEach(() => {
  clearRuntimeEnv();
  setPlatform(realPlatform);
});

// ── detectRuntime ─────────────────────────────────────────────────────────────

describe("detectRuntime", () => {
  it("returns null when no runtime env vars are set", () => {
    expect(detectRuntime()).toBeNull();
  });

  it("returns 'claude' when CLAUDECODE is set", () => {
    process.env.CLAUDECODE = "1";
    expect(detectRuntime()).toBe("claude");
  });

  it("returns 'codex' when CODEX_CI is set", () => {
    process.env.CODEX_CI = "1";
    expect(detectRuntime()).toBe("codex");
  });

  it("returns 'gemini' when GEMINI_CLI is set", () => {
    process.env.GEMINI_CLI = "1";
    expect(detectRuntime()).toBe("gemini");
  });

  it("returns 'copilot' when COPILOT_CLI is set", () => {
    process.env.COPILOT_CLI = "1";
    expect(detectRuntime()).toBe("copilot");
  });

  it("returns 'hermes' when HERMES_INTERACTIVE is set", () => {
    process.env.HERMES_INTERACTIVE = "1";
    expect(detectRuntime()).toBe("hermes");
  });

  it("returns 'hermes' when HERMES_SESSION_KEY is set", () => {
    process.env.HERMES_SESSION_KEY = "agent:main:telegram:dm:527035525";
    expect(detectRuntime()).toBe("hermes");
  });

  it("prioritises CLAUDECODE over CODEX_CI when both are set", () => {
    process.env.CLAUDECODE = "1";
    process.env.CODEX_CI = "1";
    // Object.entries order follows insertion order of RUNTIME_ENV constant
    expect(detectRuntime()).toBe("claude");
  });
});

// ── findRuntimeAncestorPid — null / error cases ───────────────────────────────

describe("findRuntimeAncestorPid — null / error cases", () => {
  it("returns null for an unknown runtime name", () => {
    expect(findRuntimeAncestorPid("unknown-runtime")).toBeNull();
  });

  it("returns null when ps exits with an error on the first pid", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ps: no such process");
    });
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });

  it("returns null when ps returns an empty string", () => {
    mockExecFileSync.mockReturnValue("   ");
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });

  it("returns null when ps output does not match expected format", () => {
    mockExecFileSync.mockReturnValue("garbage that does not parse");
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });

  it("returns null when ancestry chain reaches pid 1 without a match", () => {
    // Simulate a chain: ppid → 2 → 1 (init), no claude in sight.
    // When the queried pid is 1 (init), the loop stops because pid <= 1.
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return psLine(2, "/bin/bash");
      return psLine(1, "/sbin/init");
    });
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });
});

// ── findRuntimeAncestorPid — happy paths ─────────────────────────────────────

describe("findRuntimeAncestorPid — happy paths", () => {
  it("returns the pid of a direct parent whose command is 'claude'", () => {
    // process.ppid is the first pid queried. We stub it to report command=claude.
    const claudePid = process.ppid;
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/claude"));
    const result = findRuntimeAncestorPid("claude");
    expect(result).toBe(claudePid);
  });

  it("returns the pid of a grandparent whose command matches claude", () => {
    // Chain: process.ppid=100 → ppid=200 (claude)
    // First call: pid=process.ppid → {ppid:200, command:"/bin/bash"}
    // Second call: pid=200 → {ppid:1, command:"/usr/bin/claude"}
    mockExecFileSync.mockReturnValueOnce(psLine(200, "/bin/bash")).mockReturnValueOnce(psLine(1, "/usr/bin/claude"));

    const result = findRuntimeAncestorPid("claude");
    expect(result).toBe(200);
  });

  it("matches 'codex' runtime against codex command", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/codex"));
    expect(findRuntimeAncestorPid("codex")).toBe(process.ppid);
  });

  it("matches 'gemini' runtime against gemini command", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/gemini"));
    expect(findRuntimeAncestorPid("gemini")).toBe(process.ppid);
  });

  it("matches a command that has arguments after the runtime name", () => {
    // e.g. "claude --dangerously-skip-permissions"
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/claude --dangerously-skip-permissions"));
    expect(findRuntimeAncestorPid("claude")).toBe(process.ppid);
  });

  it("matches Hermes gateway process command", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/Users/saltbo/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run --replace"));
    expect(findRuntimeAncestorPid("hermes")).toBe(process.ppid);
  });

  it("does not match a command where runtime name is a substring of another word", () => {
    // e.g. "not-claude" should NOT match "claude" pattern
    mockExecFileSync.mockReturnValueOnce(psLine(2, "not-claude")).mockReturnValueOnce(psLine(1, "/sbin/init"));
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });
});

// ── findRuntimeAncestorPid — hard cap ────────────────────────────────────────

describe("findRuntimeAncestorPid — 32-hop hard cap", () => {
  it("stops after 32 hops and returns null when no match found", () => {
    // Build a deep chain of 40 hops, each pointing to the next pid
    // None of them have a claude command
    let pid = 10000;
    mockExecFileSync.mockImplementation(() => {
      pid++;
      return psLine(pid, "/bin/sh");
    });

    const result = findRuntimeAncestorPid("claude");
    expect(result).toBeNull();
    // Should have called ps at most 32 times (the hard cap)
    expect(mockExecFileSync).toHaveBeenCalledTimes(32);
  });
});

// ── findRuntimeAncestorPid — AK_LEADER_PID override ──────────────────────────

describe("findRuntimeAncestorPid — AK_LEADER_PID override", () => {
  it("returns AK_LEADER_PID without walking ancestry when set to a valid pid", () => {
    process.env.AK_LEADER_PID = "4242";
    expect(findRuntimeAncestorPid("claude")).toBe(4242);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("wins on win32 too, without touching the pid file", () => {
    setPlatform("win32");
    process.env.AK_LEADER_PID = "4242";
    expect(findRuntimeAncestorPid("claude")).toBe(4242);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("still returns null for an unknown runtime even when set", () => {
    process.env.AK_LEADER_PID = "4242";
    expect(findRuntimeAncestorPid("unknown-runtime")).toBeNull();
  });

  it.each(["not-a-pid", "0", "-5"])("ignores invalid value %j and falls back to the ancestry walk", (value) => {
    process.env.AK_LEADER_PID = value;
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/claude"));
    expect(findRuntimeAncestorPid("claude")).toBe(process.ppid);
  });
});

// ── findRuntimeAncestorPid — win32 daemon anchor ──────────────────────────────

describe("findRuntimeAncestorPid — win32 daemon anchor", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  it("anchors to the daemon pid from PID_FILE when the daemon is alive", () => {
    mockReadFileSync.mockReturnValue("1234\n");
    mockIsPidAlive.mockReturnValue(true);
    expect(findRuntimeAncestorPid("claude")).toBe(1234);
    // POSIX ps must never be spawned on win32
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("returns null when the pid file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });

  it("returns null when the daemon pid is no longer alive", () => {
    mockReadFileSync.mockReturnValue("1234\n");
    mockIsPidAlive.mockReturnValue(false);
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });

  it("returns null when the pid file contains garbage", () => {
    mockReadFileSync.mockReturnValue("not-a-pid");
    expect(findRuntimeAncestorPid("claude")).toBeNull();
    expect(mockIsPidAlive).not.toHaveBeenCalled();
  });
});
