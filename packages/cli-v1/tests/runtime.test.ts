// @vitest-environment node
/**
 * Tests for runtime.ts — detectRuntime() and findRuntimeAncestorPid().
 *
 * findRuntimeAncestorPid() calls execFileSync("ps", ...) internally via the
 * private readProcess() helper. We mock node:child_process to control what
 * process ancestry looks like without spawning real `ps` processes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock child_process before any imports touch it ────────────────────────────
const mockExecFileSync = vi.fn<[string, string[], object], string>();
const mockGetWindowsProcessAncestry = vi.fn();
let platformSpy: ReturnType<typeof vi.spyOn>;

vi.mock("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock("../src/agent/windowsProcessTree.js", () => ({
  getWindowsProcessAncestry: mockGetWindowsProcessAncestry,
}));

// Import after mocks are registered
const { detectRuntime, findRuntimeAncestorPid } = await import("../src/agent/runtime.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a fake `ps -o ppid=,command=` output line. */
function psLine(ppid: number, command: string): string {
  return `  ${ppid}  ${command}`;
}

// ── Environment cleanup ───────────────────────────────────────────────────────

function clearRuntimeEnv() {
  delete process.env.PI_CODING_AGENT;
  delete process.env.ANTIGRAVITY_AGENT;
  delete process.env.OPENCODE;
  delete process.env.AGENT;
  delete process.env.GOOSE_TERMINAL;
  delete process.env.QWEN_CODE;
  delete process.env.CURSOR_AGENT;
  delete process.env.AGENT_DISPLAY_OUT;
  delete process.env.AGENT_CONTEXT_OUT;
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_CI;
  delete process.env.GEMINI_CLI;
  delete process.env.COPILOT_CLI;
  delete process.env.HERMES_INTERACTIVE;
  delete process.env.HERMES_SESSION_KEY;
}

beforeEach(() => {
  clearRuntimeEnv();
  vi.clearAllMocks();
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
});

afterEach(() => {
  clearRuntimeEnv();
  vi.restoreAllMocks();
});

// ── detectRuntime ─────────────────────────────────────────────────────────────

describe("detectRuntime", () => {
  it("returns null when no runtime env vars are set", () => {
    expect(detectRuntime()).toBeNull();
  });

  it.each([
    ["ANTIGRAVITY_AGENT", "antigravity"],
    ["OPENCODE", "opencode"],
    ["GOOSE_TERMINAL", "goose"],
    ["QWEN_CODE", "qwen"],
    ["CURSOR_AGENT", "cursor"],
    ["PI_CODING_AGENT", "pi"],
    ["CODEX_CI", "codex"],
    ["COPILOT_CLI", "copilot"],
    ["GEMINI_CLI", "gemini"],
    ["CLAUDECODE", "claude"],
    ["HERMES_INTERACTIVE", "hermes"],
    ["HERMES_SESSION_KEY", "hermes"],
  ] as const)("recognizes empty %s as '%s'", (name, runtime) => {
    process.env[name] = "";
    expect(detectRuntime()).toBe(runtime);
  });

  it("returns 'goose' when AGENT=goose", () => {
    process.env.AGENT = "goose";
    expect(detectRuntime()).toBe("goose");
  });

  it("returns 'amp' when AGENT=amp", () => {
    process.env.AGENT = "amp";
    expect(detectRuntime()).toBe("amp");
  });

  it("does not recognize an unknown shared AGENT value", () => {
    process.env.AGENT = "unknown";
    expect(detectRuntime()).toBeNull();
  });

  it("prioritises AGENT=amp over CLAUDECODE", () => {
    process.env.AGENT = "amp";
    process.env.CLAUDECODE = "1";
    expect(detectRuntime()).toBe("amp");
  });

  it("returns 'kiro' when both Kiro FIFO variables are set", () => {
    process.env.AGENT_DISPLAY_OUT = "";
    process.env.AGENT_CONTEXT_OUT = "";
    expect(detectRuntime()).toBe("kiro");

    delete process.env.AGENT_CONTEXT_OUT;
    expect(detectRuntime()).toBeNull();
  });

  it("returns null when only a runtime process ancestor is present", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/local/bin/opencode"));

    expect(detectRuntime()).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
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

  it.each([
    ["antigravity", "/opt/agy --prompt task"],
    ["opencode", "/opt/opencode"],
    ["cursor", "/opt/cursor-agent --print"],
    ["qwen", "/opt/qwen --approval-mode auto-edit"],
    ["goose", "/opt/goose session"],
    ["amp", "/opt/amp --execute"],
    ["kiro", "/opt/kiro-cli chat"],
    ["pi", "/opt/pi --print"],
  ] as const)("matches the %s runtime command", (runtime, command) => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, command));

    expect(findRuntimeAncestorPid(runtime)).toBe(process.ppid);
  });

  it("matches the Pi package distribution entrypoint", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/usr/bin/node /workspace/node_modules/pi-coding-agent/dist/cli.js"));

    expect(findRuntimeAncestorPid("pi")).toBe(process.ppid);
  });

  it("does not match Pi when pi is only a command-name substring", () => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, "/opt/pilot --print"));

    expect(findRuntimeAncestorPid("pi")).toBeNull();
  });

  it.each(["/opt/antigravity --prompt task", "/opt/not-agy --prompt task"])("does not treat %s as the Antigravity CLI", (command) => {
    mockExecFileSync.mockReturnValueOnce(psLine(1, command));

    expect(findRuntimeAncestorPid("antigravity")).toBeNull();
  });

  it("does not match a command where runtime name is a substring of another word", () => {
    // e.g. "not-claude" should NOT match "claude" pattern
    mockExecFileSync.mockReturnValueOnce(psLine(2, "not-claude")).mockReturnValueOnce(psLine(1, "/sbin/init"));
    expect(findRuntimeAncestorPid("claude")).toBeNull();
  });
});

describe("findRuntimeAncestorPid — Windows ancestry", () => {
  it("uses the native process ancestry instead of ps and matches a Node-hosted Codex CLI", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([
      {
        pid: 4100,
        ppid: 4000,
        executable: "node.exe",
        commandLine: "node.exe C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      },
      { pid: 4000, ppid: 100, executable: "pwsh.exe", commandLine: "pwsh.exe" },
    ]);

    expect(findRuntimeAncestorPid("codex")).toBe(4100);
    expect(mockGetWindowsProcessAncestry).toHaveBeenCalledWith(process.ppid);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the executable name when command line access is unavailable", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([{ pid: 5100, ppid: 5000, executable: "claude.cmd", commandLine: null }]);

    expect(findRuntimeAncestorPid("claude")).toBe(5100);
  });

  it("matches a new runtime from its Windows command shim", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([{ pid: 5200, ppid: 5000, executable: "cursor-agent.cmd", commandLine: null }]);

    expect(findRuntimeAncestorPid("cursor")).toBe(5200);
  });

  it("matches the Antigravity Windows command shim", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([{ pid: 5300, ppid: 5000, executable: "agy.cmd", commandLine: null }]);

    expect(findRuntimeAncestorPid("antigravity")).toBe(5300);
  });

  it("matches the Pi Windows command shim", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([{ pid: 5400, ppid: 5000, executable: "pi.cmd", commandLine: null }]);

    expect(findRuntimeAncestorPid("pi")).toBe(5400);
  });

  it("returns null when no Windows ancestor matches the requested runtime", () => {
    platformSpy.mockReturnValue("win32");
    mockGetWindowsProcessAncestry.mockReturnValue([{ pid: 6100, ppid: 6000, executable: "node.exe", commandLine: "node.exe unrelated.js" }]);

    expect(findRuntimeAncestorPid("gemini")).toBeNull();
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
