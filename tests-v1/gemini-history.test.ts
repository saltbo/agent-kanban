// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

type FsState = {
  dirs: Record<string, string[]>;
  files: Record<string, string>;
};

const fsState = vi.hoisted((): FsState => ({ dirs: {}, files: {} }));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: (path: string) => {
    if (path in fsState.files) return fsState.files[path];
    throw new Error(`ENOENT: ${path}`);
  },
  readdirSync: (path: string) => {
    if (path in fsState.dirs) return fsState.dirs[path] as any;
    throw new Error(`ENOENT: ${path}`);
  },
}));

vi.mock("../packages/cli/src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { homedir } from "node:os";
import { join } from "node:path";
import { readGeminiHistory } from "../packages/cli/src/providers/gemini.js";

const GEMINI_TMP_DIR = join(homedir(), ".gemini", "tmp");

function resetFs(): void {
  fsState.dirs = {};
  fsState.files = {};
}

function registerSessionFile(project: string, filename: string, content: string): string {
  const projectDir = join(GEMINI_TMP_DIR, project);
  const chatsDir = join(projectDir, "chats");
  const filePath = join(chatsDir, filename);

  fsState.dirs[GEMINI_TMP_DIR] = Array.from(new Set([...(fsState.dirs[GEMINI_TMP_DIR] ?? []), project]));
  fsState.dirs[chatsDir] = Array.from(new Set([...(fsState.dirs[chatsDir] ?? []), filename]));
  fsState.files[filePath] = content;

  return filePath;
}

describe("readGeminiHistory", () => {
  beforeEach(resetFs);

  it("reads Gemini 0.40 JSONL session records", () => {
    registerSessionFile(
      "agent-kanban",
      "session-2026-05-04T05-08-8a0b23f7.jsonl",
      [
        JSON.stringify({ sessionId: "8a0b23f7-d9a5-4680-9d30-03b2a7fd0292", projectHash: "agent-kanban", startTime: "2026-05-04T05:08:31.672Z" }),
        JSON.stringify({ id: "user-1", timestamp: "2026-05-04T05:08:33.346Z", type: "user", content: [{ text: "Reply exactly: OK" }] }),
        JSON.stringify({ id: "assistant-1", timestamp: "2026-05-04T05:08:34.794Z", type: "gemini", content: "OK", model: "gemini-3-flash-preview" }),
      ].join("\n"),
    );

    const history = readGeminiHistory("8a0b23f7-d9a5-4680-9d30-03b2a7fd0292");

    expect(history).toHaveLength(2);
    expect(history[0].event).toEqual({ type: "message.user", text: "Reply exactly: OK" });
    expect(history[1].event).toEqual({ type: "message", blocks: [{ type: "text", text: "OK" }] });
  });

  it("merges resumed Gemini JSONL files for the same session id", () => {
    registerSessionFile(
      "agent-kanban",
      "session-2026-05-04T05-08-8a0b23f7.jsonl",
      [
        JSON.stringify({ sessionId: "8a0b23f7-d9a5-4680-9d30-03b2a7fd0292" }),
        JSON.stringify({ id: "user-1", timestamp: "2026-05-04T05:08:33.346Z", type: "user", content: [{ text: "first" }] }),
      ].join("\n"),
    );
    registerSessionFile(
      "agent-kanban",
      "session-2026-05-04T05-10-8a0b23f7.jsonl",
      [
        JSON.stringify({ sessionId: "8a0b23f7-d9a5-4680-9d30-03b2a7fd0292" }),
        JSON.stringify({ id: "user-2", timestamp: "2026-05-04T05:10:33.346Z", type: "user", content: [{ text: "resume" }] }),
      ].join("\n"),
    );

    const history = readGeminiHistory("8a0b23f7-d9a5-4680-9d30-03b2a7fd0292");

    expect(history.map((item) => item.event)).toEqual([
      { type: "message.user", text: "first" },
      { type: "message.user", text: "resume" },
    ]);
  });

  it("normalizes Gemini tool calls to canonical frontend tool names", () => {
    registerSessionFile(
      "agent-kanban",
      "session-2026-05-04T05-08-8a0b23f7.jsonl",
      [
        JSON.stringify({ sessionId: "8a0b23f7-d9a5-4680-9d30-03b2a7fd0292", projectHash: "agent-kanban", startTime: "2026-05-04T05:08:31.672Z" }),
        JSON.stringify({
          id: "assistant-1",
          timestamp: "2026-05-04T05:08:34.794Z",
          type: "gemini",
          content: "Running command",
          toolCalls: [
            { id: "tool-1", name: "run_shell_command", args: { command: "pnpm test", description: "Run tests" }, result: "ok" },
            { id: "tool-2", name: "read_file", args: { file_path: "README.md" }, result: "readme" },
            { id: "tool-3", name: "write_file", args: { file_path: "out.txt", content: "hello" }, result: "written" },
            { id: "tool-4", name: "glob", args: { pattern: "**/*.ts" }, result: ["a.ts"] },
            { id: "tool-5", name: "activate_skill", args: { name: "agent-kanban" }, result: "activated" },
          ],
        }),
      ].join("\n"),
    );

    const history = readGeminiHistory("8a0b23f7-d9a5-4680-9d30-03b2a7fd0292");

    expect(history[0].event).toMatchObject({
      type: "message",
      blocks: [
        { type: "text", text: "Running command" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pnpm test", description: "Run tests" } },
        { type: "tool_result", tool_use_id: "tool-1", output: "ok" },
        { type: "tool_use", id: "tool-2", name: "Read", input: { filePath: "README.md" } },
        { type: "tool_result", tool_use_id: "tool-2", output: "readme" },
        { type: "tool_use", id: "tool-3", name: "Write", input: { filePath: "out.txt", content: "hello" } },
        { type: "tool_result", tool_use_id: "tool-3", output: "written" },
        { type: "tool_use", id: "tool-4", name: "Glob", input: { pattern: "**/*.ts" } },
        { type: "tool_result", tool_use_id: "tool-4", output: "a.ts" },
      ],
    });
  });

  it("returns empty history when no session file matches", () => {
    fsState.dirs[GEMINI_TMP_DIR] = [];

    expect(readGeminiHistory("missing-session")).toEqual([]);
  });

  it("ignores JSONL files with matching short id but different full session id", () => {
    registerSessionFile(
      "agent-kanban",
      "session-2026-05-04T05-08-8a0b23f7.jsonl",
      [
        JSON.stringify({ sessionId: "8a0b23f7-0000-0000-0000-000000000000" }),
        JSON.stringify({ id: "user-1", timestamp: "2026-05-04T05:08:33.346Z", type: "user", content: [{ text: "wrong" }] }),
      ].join("\n"),
    );

    expect(readGeminiHistory("8a0b23f7-d9a5-4680-9d30-03b2a7fd0292")).toEqual([]);
  });

  it("ignores legacy JSON session files", () => {
    registerSessionFile(
      "agent-kanban",
      "session-2026-02-11T06-04-e29d5231.json",
      JSON.stringify({
        sessionId: "e29d5231-c1c9-4d89-91a8-25cdb3f3e34b",
        messages: [{ id: "user-1", timestamp: "2026-02-11T06:04:01.000Z", type: "user", content: "hello" }],
      }),
    );

    expect(readGeminiHistory("e29d5231-c1c9-4d89-91a8-25cdb3f3e34b")).toEqual([]);
  });
});
