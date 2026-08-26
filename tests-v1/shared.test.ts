import {
  AGENT_RUNTIMES,
  AGENT_STATUSES,
  deriveUsername,
  findInvalidSkillRef,
  isValidSkillRef,
  isValidUsername,
  LEADER_AGENT_RUNTIMES,
  PRIORITIES,
  RUNTIME_LABELS,
  STALE_TIMEOUT_MS,
  TASK_ACTIONS,
} from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";

describe("isValidUsername", () => {
  it("accepts lowercase alphanumeric", () => {
    expect(isValidUsername("alice")).toBe(true);
  });

  it("accepts single character", () => {
    expect(isValidUsername("a")).toBe(true);
  });

  it("accepts hyphens in the middle", () => {
    expect(isValidUsername("my-agent")).toBe(true);
    expect(isValidUsername("my-cool-agent")).toBe(true);
  });

  it("rejects leading hyphen", () => {
    expect(isValidUsername("-agent")).toBe(false);
  });

  it("rejects trailing hyphen", () => {
    expect(isValidUsername("agent-")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(isValidUsername("my agent")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isValidUsername("MyAgent")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidUsername("agent@email")).toBe(false);
    expect(isValidUsername("agent.bot")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidUsername("")).toBe(false);
  });
});

describe("deriveUsername", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(deriveUsername("My Agent")).toBe("my-agent");
  });

  it("strips non-alphanumeric characters", () => {
    expect(deriveUsername("Agent #1!")).toBe("agent-1");
  });

  it("strips leading and trailing hyphens", () => {
    expect(deriveUsername(" Agent ")).toBe("agent");
  });

  it("falls back to 'agent' for empty result", () => {
    expect(deriveUsername("!!!")).toBe("agent");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(50);
    expect(deriveUsername(long).length).toBeLessThanOrEqual(40);
  });
});

describe("isValidSkillRef", () => {
  it("accepts installable owner/repo[#ref]@skill-name refs", () => {
    expect(isValidSkillRef("trailofbits/skills@differential-review")).toBe(true);
    expect(isValidSkillRef("obra/superpowers@verification-before-completion")).toBe(true);
    expect(isValidSkillRef("saltbo/agent-kanban#feature/maintainer@ak-maintainer")).toBe(true);
  });

  it("rejects short names and malformed refs", () => {
    expect(isValidSkillRef("agent-kanban")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills@")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills@bad skill")).toBe(false);
    expect(isValidSkillRef("trailofbits/skills#@bad")).toBe(false);
  });

  it("returns the first invalid skill ref", () => {
    expect(findInvalidSkillRef(["owner/repo@good", "browse", "other/repo@good"])).toBe("browse");
    expect(findInvalidSkillRef(["owner/repo@good"])).toBeNull();
  });
});

describe("shared constants", () => {
  it("TASK_ACTIONS includes all v2 actions", () => {
    expect(TASK_ACTIONS).toContain("assigned");
    expect(TASK_ACTIONS).toContain("released");
    expect(TASK_ACTIONS).toContain("timed_out");
  });

  it("AGENT_STATUSES has online, offline", () => {
    expect(AGENT_STATUSES).toEqual(["online", "offline"]);
  });

  it("STALE_TIMEOUT_MS is 24 hours", () => {
    expect(STALE_TIMEOUT_MS).toBe(86400000);
  });

  it("PRIORITIES has 4 levels", () => {
    expect(PRIORITIES).toHaveLength(4);
    expect(PRIORITIES).toContain("urgent");
  });

  it("keeps worker runtimes separate from the broader leader runtime set", () => {
    expect(AGENT_RUNTIMES).toEqual(["claude", "codex", "gemini", "copilot", "hermes", "ama"]);
    expect(LEADER_AGENT_RUNTIMES).toEqual([
      "claude",
      "codex",
      "gemini",
      "copilot",
      "hermes",
      "antigravity",
      "opencode",
      "cursor",
      "qwen",
      "goose",
      "amp",
      "kiro",
      "pi",
    ]);
    expect(LEADER_AGENT_RUNTIMES).not.toContain("ama");
  });

  it("defines display labels for every supported runtime", () => {
    expect(Object.keys(RUNTIME_LABELS).sort()).toEqual([...new Set([...AGENT_RUNTIMES, ...LEADER_AGENT_RUNTIMES])].sort());
    expect(RUNTIME_LABELS).toMatchObject({
      antigravity: "Antigravity CLI",
      opencode: "OpenCode",
      cursor: "Cursor CLI",
      qwen: "Qwen Code",
      goose: "Goose",
      amp: "Amp",
      kiro: "Kiro CLI",
      pi: "Pi Agent",
    });
  });
});
