// @vitest-environment node
/**
 * Unit tests for formatAgentList in output.ts.
 *
 * Tests the contract of the function: role, runtime, and bio rendering,
 * graceful handling of absent fields, and multi-agent output.
 */

import { describe, expect, it } from "vitest";
import { formatAgentList } from "../src/output.js";

describe("formatAgentList — empty input", () => {
  it("returns 'No agents found.' for an empty array", () => {
    expect(formatAgentList([])).toBe("No agents found.");
  });
});

describe("formatAgentList — all fields present", () => {
  const agent = { id: "agent-1", status: "idle", name: "Alice", role: "reviewer", runtime: "node", bio: "Helpful bot" };

  it("includes the agent id", () => {
    expect(formatAgentList([agent])).toContain("agent-1");
  });

  it("includes the status wrapped in brackets", () => {
    expect(formatAgentList([agent])).toContain("[idle]");
  });

  it("includes the agent name", () => {
    expect(formatAgentList([agent])).toContain("Alice");
  });

  it("includes the role wrapped in parentheses", () => {
    expect(formatAgentList([agent])).toContain("(reviewer)");
  });

  it("includes the runtime", () => {
    expect(formatAgentList([agent])).toContain("node");
  });

  it("includes the bio with em-dash prefix", () => {
    expect(formatAgentList([agent])).toContain(" — Helpful bot");
  });
});

describe("formatAgentList — missing role", () => {
  const agent = { id: "agent-2", status: "working", name: "Bob", runtime: "bun", bio: "Code monkey" };

  it("does not include parenthesised role text when role is absent", () => {
    expect(formatAgentList([agent])).not.toMatch(/\(\w/);
  });

  it("still includes name when role is absent", () => {
    expect(formatAgentList([agent])).toContain("Bob");
  });

  it("still includes bio when role is absent", () => {
    expect(formatAgentList([agent])).toContain(" — Code monkey");
  });
});

describe("formatAgentList — missing bio", () => {
  const agent = { id: "agent-3", status: "idle", name: "Carol", role: "worker", runtime: "deno" };

  it("does not include em-dash when bio is absent", () => {
    expect(formatAgentList([agent])).not.toContain(" — ");
  });

  it("still includes role when bio is absent", () => {
    expect(formatAgentList([agent])).toContain("(worker)");
  });
});

describe("formatAgentList — missing role and bio", () => {
  const agent = { id: "agent-4", status: "offline", name: "Dave", runtime: "node" };

  it("does not include parenthesised role", () => {
    expect(formatAgentList([agent])).not.toContain("(");
  });

  it("does not include em-dash bio prefix", () => {
    expect(formatAgentList([agent])).not.toContain(" — ");
  });
});

describe("formatAgentList — missing runtime", () => {
  const agent = { id: "agent-5", status: "idle", name: "Eve" };

  it("handles undefined runtime without throwing", () => {
    expect(() => formatAgentList([agent])).not.toThrow();
  });

  it("still renders the agent id when runtime is undefined", () => {
    expect(formatAgentList([agent])).toContain("agent-5");
  });

  it("still renders the agent name when runtime is undefined", () => {
    expect(formatAgentList([agent])).toContain("Eve");
  });
});

describe("formatAgentList — multiple agents", () => {
  const agents = [
    { id: "a1", status: "idle", name: "Alpha" },
    { id: "a2", status: "working", name: "Beta" },
  ];

  it("renders each agent on its own line", () => {
    const lines = formatAgentList(agents).split("\n");
    expect(lines).toHaveLength(2);
  });

  it("places first agent on first line", () => {
    const lines = formatAgentList(agents).split("\n");
    expect(lines[0]).toContain("a1");
  });

  it("places second agent on second line", () => {
    const lines = formatAgentList(agents).split("\n");
    expect(lines[1]).toContain("a2");
  });
});
