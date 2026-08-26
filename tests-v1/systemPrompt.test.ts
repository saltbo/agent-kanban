// @vitest-environment node

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../packages/cli/src/agent/systemPrompt.js";
import { cleanupPromptFile, generateSystemPrompt, writePromptFile } from "../packages/cli/src/agent/systemPrompt.js";

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    name: "TestAgent",
    username: "test-agent",
    bio: null,
    role: "developer",
    soul: null,
    handoff_to: null,
    skills: null,
    subagents: null,
    runtime: "claude-cli",
    model: null,
    ...overrides,
  };
}

// ─── Workflow boundary ─────────────────────────────────────────────────────

describe("generateSystemPrompt — dev board", () => {
  it("directs agents to read the installed agent-kanban skill", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).toContain("The detailed task workflow is defined by the installed `agent-kanban` skill");
    expect(prompt).toContain(".agents/skills/agent-kanban/SKILL.md");
    expect(prompt).toContain(".claude/skills/agent-kanban/SKILL.md");
  });

  it("keeps detailed PR and CI workflow out of the system prompt", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).not.toContain("gh pr checks");
    expect(prompt).not.toContain("gh pr create");
    expect(prompt).not.toContain("Check for conflicts");
  });

  it("keeps completion note and profile proposal details out of the system prompt", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).not.toContain("Completion Summary:");
    expect(prompt).not.toContain("Agent Profile Proposal");
    expect(prompt).not.toContain("candidate `Agent` YAML");
  });

  it("does NOT contain ak task log anywhere", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).not.toContain("ak task log");
  });

  it("keeps platform review boundary in the system prompt", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).toContain("`task review` is always your final action");
  });

  it("defines precedence between platform workflow and soul", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).toContain("take precedence over your soul");
    expect(prompt).toContain("skill's completion-note process");
  });

  it("includes agent identity with correct id", () => {
    const prompt = generateSystemPrompt(makeAgent({ id: "agent-42" }), "dev");
    expect(prompt).toContain("https://agent-kanban.dev/agents/agent-42");
  });

  it("includes agent name", () => {
    const prompt = generateSystemPrompt(makeAgent({ name: "Coder" }), "dev");
    expect(prompt).toContain("Name: Coder");
  });

  it("includes agent role", () => {
    const prompt = generateSystemPrompt(makeAgent({ role: "backend" }), "dev");
    expect(prompt).toContain("Role: backend");
  });

  it("falls back to 'general' role when role is null", () => {
    const prompt = generateSystemPrompt(makeAgent({ role: null }), "dev");
    expect(prompt).toContain("Role: general");
  });

  it("includes agent runtime", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).toContain("Runtime: claude-cli");
  });

  it("Handoff is described in its own section, not as a numbered lifecycle step", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa"] }), "dev");
    expect(prompt).toContain("## Handoff");
    expect(prompt).not.toMatch(/^\d+\.\s+\*\*Handoff/m);
  });
});

// ─── OPS board ─────────────────────────────────────────────────────────────

describe("generateSystemPrompt — ops board", () => {
  it("directs ops agents to read the installed agent-kanban skill", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).toContain("The detailed task workflow is defined by the installed `agent-kanban` skill");
  });

  it("does NOT contain ak task log anywhere", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).not.toContain("ak task log");
  });

  it("does NOT contain gh pr checks (ops has no PR step)", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).not.toContain("gh pr checks");
  });

  it("does NOT contain gh pr create (ops has no PR step)", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).not.toContain("gh pr create");
  });

  it("keeps platform review boundary in the system prompt", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).toContain("`task review` is always your final action");
  });

  it("defines precedence between platform workflow and soul", () => {
    const prompt = generateSystemPrompt(makeAgent(), "ops");
    expect(prompt).toContain("take precedence over your soul");
    expect(prompt).toContain("skill's completion-note process");
  });
});

// ─── Handoff section ────────────────────────────────────────────────────────

describe("generateSystemPrompt — handoff section", () => {
  it("omits handoff section when handoff_to is null", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: null }), "dev");
    expect(prompt).not.toContain("## Handoff");
  });

  it("omits handoff section when handoff_to is empty array", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: [] }), "dev");
    expect(prompt).not.toContain("## Handoff");
  });

  it("includes handoff section when handoff_to has roles", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa", "devops"] }), "dev");
    expect(prompt).toContain("## Handoff");
  });

  it("lists handoff roles in handoff section", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa", "devops"] }), "dev");
    expect(prompt).toContain("qa, devops");
  });

  it("handoff section uses ak create note --task for logging the handoff", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa"] }), "dev");
    expect(prompt).toContain("ak create note --task <current-task-id>");
  });

  it("handoff section does NOT use ak task log for the handoff log step", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa"] }), "dev");
    expect(prompt).not.toContain("ak task log");
  });

  it("includes --repo flag in dev board handoff task create", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa"] }), "dev");
    expect(prompt).toContain("--repo <repo>");
  });

  it("does NOT include --repo flag in ops board handoff task create", () => {
    const prompt = generateSystemPrompt(makeAgent({ handoff_to: ["qa"] }), "ops");
    expect(prompt).not.toContain("--repo <repo>");
  });
});

// ─── Subagent section ───────────────────────────────────────────────────────

describe("generateSystemPrompt — subagent section", () => {
  it("omits subagent section when no subagents are installed", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev");
    expect(prompt).not.toContain("## Available Subagents");
  });

  it("lists registered subagent usernames as mentions", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev", [
      makeAgent({
        id: "subagent-1",
        name: "Test Writer",
        username: "test-writer",
        role: "subagent-test-role",
        bio: "Subagent test bio must not appear.",
        soul: "Subagent soul must not appear.",
      }),
    ]);
    expect(prompt).toContain("## Available Subagents");
    expect(prompt).toContain("@test-writer");
    expect(prompt).not.toContain("subagent-1");
    expect(prompt).not.toContain("Test Writer");
    expect(prompt).not.toContain("subagent-test-role");
    expect(prompt).not.toContain("Subagent test bio must not appear.");
    expect(prompt).not.toContain("Subagent soul must not appear.");
  });

  it("only injects subagent environment facts", () => {
    const prompt = generateSystemPrompt(makeAgent(), "dev", [makeAgent({ id: "subagent-1", name: "Reviewer", username: "reviewer" })]);
    expect(prompt).toContain("The following task-local subagents are installed: @reviewer");
    expect(prompt).not.toContain("template");
    expect(prompt).not.toContain("when to use");
    expect(prompt).not.toContain("how to use");
    expect(prompt).not.toContain("delegate");
    expect(prompt).not.toContain("delegation");
  });
});

// ─── Soul section ───────────────────────────────────────────────────────────

describe("generateSystemPrompt — soul", () => {
  it("includes soul content when provided", () => {
    const prompt = generateSystemPrompt(makeAgent({ soul: "Be concise." }), "dev");
    expect(prompt).toContain("Be concise.");
  });

  it("does not crash when soul is null", () => {
    expect(() => generateSystemPrompt(makeAgent({ soul: null }), "dev")).not.toThrow();
  });
});

// ─── writePromptFile / cleanupPromptFile ────────────────────────────────────

describe("writePromptFile", () => {
  it("writes content to a temp file named by session id", () => {
    const sessionId = `test-session-${Date.now()}`;
    const content = "test prompt content";
    const filePath = writePromptFile(sessionId, content);
    try {
      expect(readFileSync(filePath, "utf-8")).toBe(content);
      expect(filePath).toContain(`ak-prompt-${sessionId}.txt`);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("returns the full path to the written file", () => {
    const sessionId = `test-session-path-${Date.now()}`;
    const filePath = writePromptFile(sessionId, "x");
    try {
      expect(filePath).toBe(join(tmpdir(), `ak-prompt-${sessionId}.txt`));
    } finally {
      unlinkSync(filePath);
    }
  });
});

describe("cleanupPromptFile", () => {
  it("deletes the prompt file for the given session id", () => {
    const sessionId = `test-cleanup-${Date.now()}`;
    const filePath = writePromptFile(sessionId, "content");
    expect(existsSync(filePath)).toBe(true);
    cleanupPromptFile(sessionId);
    expect(existsSync(filePath)).toBe(false);
  });

  it("does not throw when the file does not exist", () => {
    expect(() => cleanupPromptFile("nonexistent-session-xyz")).not.toThrow();
  });
});
