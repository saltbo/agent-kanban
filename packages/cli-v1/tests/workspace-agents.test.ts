// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ensureSubagents, testExports } from "../src/workspace/agents.js";

const subagent = {
  id: "agent-test-writer",
  name: "Test Writer",
  username: "test-writer",
  bio: "Writes focused tests",
  role: "test-writer",
  soul: "Add behavior tests before reporting completion.",
  models: { claude: "claude-opus-4-6", codex: "gpt-5.1-codex" },
};

let tempDirs: string[] = [];

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ak-workspace-agents-"));
  tempDirs = [...tempDirs, dir];
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("workspace subagent installer", () => {
  it("renders Claude agent definitions with yaml frontmatter", async () => {
    const content = testExports.renderMarkdownAgent("claude", subagent);

    expect(content).toContain("---\n");
    expect(content).toContain("name: test-writer");
    expect(content).toContain("description: Writes focused tests");
    expect(content).toContain("model: claude-opus-4-6");
    expect(content).toContain("You are Test Writer.");
    expect(content).toContain("Role: test-writer");
    expect(content).toContain("Add behavior tests before reporting completion.");
  });

  it("renders Codex agent definitions as toml", async () => {
    const content = testExports.renderCodexAgent({
      ...subagent,
      id: "agent-clean-code-reviewer",
      name: "Clean Code Reviewer",
      username: "clean-code-reviewer",
      models: { codex: "gpt-5.1-codex" },
    });

    expect(content).toContain('name = "clean-code-reviewer"');
    expect(content).toContain('description = "Writes focused tests"');
    expect(content).toContain('model = "gpt-5.1-codex"');
    expect(content).toContain('developer_instructions = """');
    expect(content).toContain("You are Clean Code Reviewer.");
  });

  it("writes Claude subagents and managed gitignore entries", async () => {
    const worktree = makeWorktree();

    const installed = await ensureSubagents(worktree, "claude", [subagent]);

    expect(installed).toBe(true);
    expect(readFileSync(join(worktree, ".claude/agents/test-writer.md"), "utf-8")).toBe(testExports.renderMarkdownAgent("claude", subagent));
    expect(readFileSync(join(worktree, ".gitignore"), "utf-8")).toContain(".claude/agents/");
    expect(readFileSync(join(worktree, ".gitignore"), "utf-8")).toContain(".codex/agents/");
    expect(readFileSync(join(worktree, ".gitignore"), "utf-8")).toContain(".gemini/agents/");
  });

  it("writes Codex subagents and keeps identical files stable", async () => {
    const worktree = makeWorktree();
    const codexSubagent = {
      ...subagent,
      id: "agent-clean-code-reviewer",
      name: "Clean Code Reviewer",
      username: "clean-code-reviewer",
      models: { codex: "gpt-5.1-codex" },
    };

    expect(await ensureSubagents(worktree, "codex", [codexSubagent])).toBe(true);
    const filePath = join(worktree, ".codex/agents/clean-code-reviewer.toml");
    const firstMtime = statSync(filePath).mtimeMs;

    expect(readFileSync(filePath, "utf-8")).toBe(testExports.renderCodexAgent(codexSubagent));
    expect(await ensureSubagents(worktree, "codex", [codexSubagent])).toBe(true);
    expect(statSync(filePath).mtimeMs).toBe(firstMtime);
  });

  it("writes Gemini subagents as project markdown agent definitions", async () => {
    const worktree = makeWorktree();
    const geminiSubagent = { ...subagent, models: { gemini: "gemini-3-pro" } };

    expect(await ensureSubagents(worktree, "gemini", [geminiSubagent])).toBe(true);
    const content = readFileSync(join(worktree, ".gemini/agents/test-writer.md"), "utf-8");

    expect(content).toBe(testExports.renderMarkdownAgent("gemini", geminiSubagent));
    expect(content).toContain("name: test-writer");
    expect(content).not.toContain("model:");
  });

  it("writes Copilot subagents through Claude-compatible project markdown agent definitions", async () => {
    const worktree = makeWorktree();
    const copilotSubagent = { ...subagent, models: { copilot: "gpt-5.2" } };

    expect(await ensureSubagents(worktree, "copilot", [copilotSubagent])).toBe(true);
    const content = readFileSync(join(worktree, ".claude/agents/test-writer.md"), "utf-8");

    expect(content).toBe(testExports.renderMarkdownAgent("copilot", copilotSubagent));
    expect(content).toContain("name: test-writer");
    expect(content).not.toContain("model:");
  });

  it("does not leak Claude model frontmatter into Gemini or Copilot agent files", async () => {
    const worktree = makeWorktree();
    const claudeWorker = { ...subagent, models: { claude: "claude-opus-4-6" } };

    expect(await ensureSubagents(worktree, "gemini", [claudeWorker])).toBe(true);
    expect(await ensureSubagents(worktree, "copilot", [claudeWorker])).toBe(true);

    expect(readFileSync(join(worktree, ".gemini/agents/test-writer.md"), "utf-8")).not.toContain("model:");
    expect(readFileSync(join(worktree, ".claude/agents/test-writer.md"), "utf-8")).not.toContain("model:");
  });

  it("returns false when the runtime does not support local subagent files", async () => {
    const worktree = makeWorktree();

    await expect(ensureSubagents(worktree, "hermes", [subagent])).resolves.toBe(false);
  });
});
