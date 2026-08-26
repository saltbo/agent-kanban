// @vitest-environment node
/**
 * Unit tests for Codex session history helpers:
 *   - mapResponseItem (payload → AgentEvent)  — exercised via getCodexHistory
 *   - getCodexHistory (JSONL file → HistoryEvent[])
 *   - findSessionFile (directory walk → path | null)
 *
 * Because CODEX_SESSIONS_DIR is a module-level constant (evaluated at import
 * time), we cannot redirect it via homedir patching. Instead we mock
 * `node:fs` to intercept `readdirSync` and `readFileSync` and provide an
 * in-memory directory tree and file contents for each test.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── fs mock ───────────────────────────────────────────────────────────────────
// Keep a mutable reference so individual tests can configure their own tree.

type FsState = {
  dirs: Record<string, string[]>; // path → children
  files: Record<string, string>; // path → content
};

const fsState = vi.hoisted((): FsState => ({ dirs: {}, files: {} }));

vi.mock("node:fs", () => ({
  readFileSync: (path: string, _enc: string) => {
    if (path in fsState.files) return fsState.files[path];
    const err = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    throw err;
  },
  readdirSync: (path: string) => {
    if (path in fsState.dirs) return fsState.dirs[path] as any;
    const err = Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    throw err;
  },
  // unused by codex history helpers but imported at module top-level
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

// Suppress child_process used by readAccessToken
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation(() => {
    throw new Error("not in tests");
  }),
}));

vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Import under test (after mocks are established) ──────────────────────────

import { homedir } from "node:os";
import { join } from "node:path";
import { readCodexJsonl as getCodexHistory } from "../packages/cli/src/providers/codex.js";

// Build the path prefix that matches CODEX_SESSIONS_DIR inside codex.ts
const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

// ── Helpers ───────────────────────────────────────────────────────────────────

function resetFs(): void {
  fsState.dirs = {};
  fsState.files = {};
}

/**
 * Register a JSONL file reachable at SESSIONS_DIR/<year>/<month>/<day>/<name>
 * and wire up all parent dir entries so readdirSync works.
 */
function registerFile(year: string, month: string, day: string, filename: string, lines: object[]): string {
  const yearDir = join(SESSIONS_DIR, year);
  const monthDir = join(yearDir, month);
  const dayDir = join(monthDir, day);
  const filePath = join(dayDir, filename);

  // Populate dirs (append if entry already exists)
  fsState.dirs[SESSIONS_DIR] = [...(fsState.dirs[SESSIONS_DIR] ?? []), year].filter((v, i, a) => a.indexOf(v) === i);
  fsState.dirs[yearDir] = [...(fsState.dirs[yearDir] ?? []), month].filter((v, i, a) => a.indexOf(v) === i);
  fsState.dirs[monthDir] = [...(fsState.dirs[monthDir] ?? []), day].filter((v, i, a) => a.indexOf(v) === i);
  fsState.dirs[dayDir] = [...(fsState.dirs[dayDir] ?? []), filename].filter((v, i, a) => a.indexOf(v) === i);

  fsState.files[filePath] = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
  return filePath;
}

function assistantLine(text: string, ts = "2025-04-14T10:00:00.000Z") {
  return {
    type: "response_item",
    timestamp: ts,
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

// ---------------------------------------------------------------------------
// mapResponseItem — assistant message
// ---------------------------------------------------------------------------

describe("getCodexHistory — assistant message payload", () => {
  beforeEach(resetFs);

  it("returns empty array when sessions dir does not exist (readdirSync throws)", () => {
    // dirs is empty so readdirSync(SESSIONS_DIR) will throw
    expect(getCodexHistory("no-thread")).toEqual([]);
  });

  it("returns empty array when sessions dir exists but is empty", () => {
    fsState.dirs[SESSIONS_DIR] = [];
    expect(getCodexHistory("no-thread")).toEqual([]);
  });

  it("returns empty array when no file ending in <threadId>.jsonl is found", () => {
    registerFile("2025", "04", "14", "session-other.jsonl", [assistantLine("hello")]);
    expect(getCodexHistory("missing-thread")).toEqual([]);
  });

  it("maps assistant output_text to a message event with a text block", () => {
    registerFile("2025", "04", "14", "session-thread-abc.jsonl", [assistantLine("Hello from Codex")]);
    const events = getCodexHistory("thread-abc");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message");
    if (events[0].event.type === "message") {
      expect(events[0].event.blocks[0]).toMatchObject({ type: "text", text: "Hello from Codex" });
    }
  });

  it("uses the JSONL line timestamp as event timestamp", () => {
    const ts = "2025-04-14T12:34:56.789Z";
    registerFile("2025", "04", "14", "file-thread-ts.jsonl", [assistantLine("hi", ts)]);
    const events = getCodexHistory("thread-ts");
    expect(events[0].timestamp).toBe(ts);
  });

  it("assigns sequential ids starting at codex-hist-1", () => {
    registerFile("2025", "04", "14", "file-thread-ids.jsonl", [assistantLine("first"), assistantLine("second")]);
    const events = getCodexHistory("thread-ids");
    expect(events[0].id).toBe("codex-hist-1");
    expect(events[1].id).toBe("codex-hist-2");
  });

  it("joins multiple output_text content parts with newline", () => {
    registerFile("2025", "04", "14", "file-thread-multi.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "part one" },
            { type: "output_text", text: "part two" },
          ],
        },
      },
    ]);
    const events = getCodexHistory("thread-multi");
    expect(events).toHaveLength(1);
    if (events[0].event.type === "message") {
      expect(events[0].event.blocks[0]).toMatchObject({ type: "text", text: "part one\npart two" });
    }
  });
});

// ---------------------------------------------------------------------------
// mapResponseItem — user message
// ---------------------------------------------------------------------------

describe("getCodexHistory — user message payload", () => {
  beforeEach(resetFs);

  it("maps user input_text to message.user event", () => {
    registerFile("2025", "04", "14", "file-thread-user.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
      },
    ]);
    const events = getCodexHistory("thread-user");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message.user");
    if (events[0].event.type === "message.user") {
      expect(events[0].event.text).toBe("do the thing");
    }
  });

  it("joins multiple input_text parts with newline", () => {
    registerFile("2025", "04", "14", "file-thread-uparts.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "line one" },
            { type: "input_text", text: "line two" },
          ],
        },
      },
    ]);
    const events = getCodexHistory("thread-uparts");
    expect(events).toHaveLength(1);
    if (events[0].event.type === "message.user") {
      expect(events[0].event.text).toBe("line one\nline two");
    }
  });

  it("skips user message when content has no input_text blocks", () => {
    registerFile("2025", "04", "14", "file-thread-uempty.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "user", content: [] },
      },
    ]);
    expect(getCodexHistory("thread-uempty")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mapResponseItem — function_call
// ---------------------------------------------------------------------------

describe("getCodexHistory — function_call payload", () => {
  beforeEach(resetFs);

  it("maps function_call to message with tool_use block", () => {
    registerFile("2025", "04", "14", "file-thread-fncall.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "ls -la" }),
          call_id: "call-1",
        },
      },
    ]);
    const events = getCodexHistory("thread-fncall");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message");
    if (events[0].event.type === "message") {
      const block = events[0].event.blocks[0];
      expect(block.type).toBe("tool_use");
      if (block.type === "tool_use") {
        expect(block.name).toBe("Bash");
        expect(block.id).toBe("call-1");
        expect(block.input).toEqual({ command: "ls -la" });
      }
    }
  });

  it("parses arguments JSON string into block input object", () => {
    registerFile("2025", "04", "14", "file-thread-fnargs.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "git status", cwd: "/tmp" }),
          call_id: "c2",
        },
      },
    ]);
    const events = getCodexHistory("thread-fnargs");
    if (events[0].event.type === "message") {
      const block = events[0].event.blocks[0];
      if (block.type === "tool_use") {
        // exec_command is normalized: name → "Bash", cmd field → command field
        expect(block.name).toBe("Bash");
        expect(block.input).toEqual({ command: "git status" });
      }
    }
  });

  it("uses call_id as the tool_use block id", () => {
    registerFile("2025", "04", "14", "file-thread-fnid.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "function_call", name: "tool", arguments: "{}", call_id: "my-call-id" },
      },
    ]);
    const events = getCodexHistory("thread-fnid");
    if (events[0].event.type === "message") {
      const block = events[0].event.blocks[0];
      if (block.type === "tool_use") expect(block.id).toBe("my-call-id");
    }
  });
});

// ---------------------------------------------------------------------------
// mapResponseItem — function_call_output
// ---------------------------------------------------------------------------

describe("getCodexHistory — function_call_output payload", () => {
  beforeEach(resetFs);

  it("maps function_call_output to message with tool_result block", () => {
    registerFile("2025", "04", "14", "file-thread-fnout.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "function_call_output", call_id: "call-1", output: "command output here" },
      },
    ]);
    const events = getCodexHistory("thread-fnout");
    expect(events).toHaveLength(1);
    expect(events[0].event.type).toBe("message");
    if (events[0].event.type === "message") {
      const block = events[0].event.blocks[0];
      expect(block.type).toBe("tool_result");
      if (block.type === "tool_result") {
        expect(block.tool_use_id).toBe("call-1");
        expect(block.output).toBe("command output here");
      }
    }
  });

  it("uses empty string for tool_use_id when call_id is absent", () => {
    registerFile("2025", "04", "14", "file-thread-fnoutnoid.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "function_call_output", output: "some output" },
      },
    ]);
    const events = getCodexHistory("thread-fnoutnoid");
    expect(events).toHaveLength(1);
    if (events[0].event.type === "message") {
      const block = events[0].event.blocks[0];
      if (block.type === "tool_result") expect(block.tool_use_id).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// Skipped entries
// ---------------------------------------------------------------------------

describe("getCodexHistory — skipped entries", () => {
  beforeEach(resetFs);

  it("skips developer role messages", () => {
    registerFile("2025", "04", "14", "file-thread-dev.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "developer", content: [{ type: "text", text: "sys" }] },
      },
    ]);
    expect(getCodexHistory("thread-dev")).toHaveLength(0);
  });

  it("skips event_msg type lines", () => {
    registerFile("2025", "04", "14", "file-thread-evmsg.jsonl", [{ type: "event_msg", timestamp: "2025-04-14T10:00:00.000Z", data: {} }]);
    expect(getCodexHistory("thread-evmsg")).toHaveLength(0);
  });

  it("skips session_meta type lines", () => {
    registerFile("2025", "04", "14", "file-thread-smeta.jsonl", [{ type: "session_meta", timestamp: "2025-04-14T10:00:00.000Z", meta: {} }]);
    expect(getCodexHistory("thread-smeta")).toHaveLength(0);
  });

  it("skips unknown payload types", () => {
    registerFile("2025", "04", "14", "file-thread-unk.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "some_future_type" },
      },
    ]);
    expect(getCodexHistory("thread-unk")).toHaveLength(0);
  });

  it("skips assistant message when content array is empty", () => {
    registerFile("2025", "04", "14", "file-thread-emptyast.jsonl", [
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "assistant", content: [] },
      },
    ]);
    expect(getCodexHistory("thread-emptyast")).toHaveLength(0);
  });

  it("skips blank lines without throwing", () => {
    const filePath = registerFile("2025", "04", "14", "file-thread-blank.jsonl", []);
    // Overwrite with content that has blank lines + a valid line
    fsState.files[filePath] =
      "\n   \n" +
      JSON.stringify({
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      }) +
      "\n";
    expect(getCodexHistory("thread-blank")).toHaveLength(1);
  });

  it("skips invalid JSON lines without throwing", () => {
    const filePath = registerFile("2025", "04", "14", "file-thread-badjson.jsonl", []);
    fsState.files[filePath] =
      "not-valid-json{{{\n" +
      JSON.stringify({
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "valid" }] },
      }) +
      "\n";
    expect(getCodexHistory("thread-badjson")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findSessionFile — directory traversal
// ---------------------------------------------------------------------------

describe("findSessionFile — directory traversal", () => {
  beforeEach(resetFs);

  it("finds a file nested under a different year/month/day tree", () => {
    registerFile("2024", "12", "31", "session-thread-nested.jsonl", [assistantLine("hi")]);
    expect(getCodexHistory("thread-nested")).toHaveLength(1);
  });

  it("returns empty array when sessions dir has year dirs but no matching file", () => {
    // Register a file with a different thread id
    registerFile("2025", "01", "01", "session-other-thread.jsonl", [assistantLine("hi")]);
    expect(getCodexHistory("completely-different")).toHaveLength(0);
  });

  it("matches file by suffix: any prefix before <threadId>.jsonl works", () => {
    registerFile("2025", "04", "14", "2025-04-14T10-00-00-thread-suffix.jsonl", [assistantLine("hi")]);
    expect(getCodexHistory("thread-suffix")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mixed JSONL
// ---------------------------------------------------------------------------

describe("getCodexHistory — mixed JSONL file", () => {
  beforeEach(resetFs);

  it("processes all valid response_item lines while skipping others", () => {
    registerFile("2025", "04", "14", "file-thread-mixed.jsonl", [
      { type: "session_meta", meta: {} },
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:00.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do it" }] },
      },
      { type: "event_msg", data: {} },
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:01.000Z",
        payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" },
      },
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:02.000Z",
        payload: { type: "function_call_output", call_id: "c1", output: "done" },
      },
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:03.000Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "finished" }] },
      },
      // developer — skipped
      {
        type: "response_item",
        timestamp: "2025-04-14T10:00:04.000Z",
        payload: { type: "message", role: "developer", content: [] },
      },
    ]);

    const events = getCodexHistory("thread-mixed");
    expect(events).toHaveLength(4);
    expect(events[0].event.type).toBe("message.user");
    expect(events[1].event.type).toBe("message"); // function_call
    expect(events[2].event.type).toBe("message"); // function_call_output
    expect(events[3].event.type).toBe("message"); // assistant
  });
});
