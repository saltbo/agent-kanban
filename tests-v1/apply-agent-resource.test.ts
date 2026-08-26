// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const output = vi.fn();

vi.mock("../packages/cli/src/output.js", () => ({
  output,
}));

const { applyResource } = await import("../packages/cli/src/apply/kinds.js");
const { parseResourceDocs } = await import("../packages/cli/src/apply/parser.js");

function client() {
  return {
    createAgent: vi.fn(async (body) => ({ id: "agent-1", ...body })),
    updateAgent: vi.fn(async (id, body) => ({ id, ...body })),
    createSubagent: vi.fn(async (body) => ({ id: "subagent-1", ...body })),
    updateSubagent: vi.fn(async (id, body) => ({ id, ...body })),
  };
}

describe("apply agent resources", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    output.mockReset();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("creates worker agents from metadata identity", async () => {
    const api = client();

    await applyResource(api as any, "Agent", { role: "builder", runtime: "codex" }, "json", {
      name: "morgan",
      annotations: {
        "agent-kanban.dev/nickname": "Morgan Lee",
      },
    });

    expect(api.createAgent).toHaveBeenCalledWith({
      username: "morgan",
      name: "Morgan Lee",
      role: "builder",
      runtime: "codex",
      kind: "worker",
    });
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "agent-1" }), "json", expect.any(Function), {
      kind: "agent",
    });
  });

  it("updates agents without sending immutable metadata identity", async () => {
    const api = client();

    await applyResource(api as any, "Agent", { id: "agent-1", role: "reviewer" }, "json", {
      name: "riley",
      annotations: {
        "agent-kanban.dev/nickname": "Riley Chen",
      },
    });

    expect(api.updateAgent).toHaveBeenCalledWith("agent-1", {
      name: "Riley Chen",
      role: "reviewer",
    });
  });

  it.each([
    ["spec.kind", { kind: "leader" }],
    ["spec.username", { username: "legacy-worker" }],
    ["spec.name", { name: "Legacy Worker" }],
  ])("rejects %s", async (_field, spec) => {
    const api = client();

    await expect(applyResource(api as any, "Agent", spec, "json", { name: "worker" })).rejects.toThrow("process.exit");

    expect(api.createAgent).not.toHaveBeenCalled();
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("parses Kubernetes-style metadata from apply files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-apply-agent-"));
    const file = join(dir, "agent.yaml");

    try {
      writeFileSync(
        file,
        [
          "kind: Agent",
          "metadata:",
          "  name: jordan",
          "  annotations:",
          "    agent-kanban.dev/nickname: Jordan Patel",
          "spec:",
          "  role: tester",
          "  runtime: codex",
          "  handoffTo:",
          "    - reviewer",
        ].join("\n"),
      );

      expect(parseResourceDocs(file)).toEqual([
        {
          kind: "Agent",
          metadata: {
            name: "jordan",
            annotations: {
              "agent-kanban.dev/nickname": "Jordan Patel",
            },
          },
          spec: {
            role: "tester",
            runtime: "codex",
            handoff_to: ["reviewer"],
          },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates subagents from metadata identity", async () => {
    const api = client();

    await applyResource(
      api as any,
      "Subagent",
      {
        role: "test-specialist",
        bio: "Focused tests",
        soul: "Write focused tests and report evidence.",
        models: { codex: "gpt-5.3-codex" },
        skills: ["org/repo@test-skill"],
      },
      "json",
      {
        name: "test-specialist",
        annotations: {
          "agent-kanban.dev/nickname": "Test Specialist",
        },
      },
    );

    expect(api.createSubagent).toHaveBeenCalledWith({
      username: "test-specialist",
      name: "Test Specialist",
      role: "test-specialist",
      bio: "Focused tests",
      soul: "Write focused tests and report evidence.",
      models: { codex: "gpt-5.3-codex" },
      skills: ["org/repo@test-skill"],
    });
    expect(output).toHaveBeenCalledWith(expect.objectContaining({ id: "subagent-1" }), "json", expect.any(Function), {
      kind: "subagent",
    });
  });

  it("updates subagents without sending immutable metadata identity", async () => {
    const api = client();

    await applyResource(api as any, "SubAgent", { id: "subagent-1", role: "review-specialist" }, "json", {
      name: "ignored-username",
      annotations: {
        "agent-kanban.dev/nickname": "Review Specialist",
      },
    });

    expect(api.updateSubagent).toHaveBeenCalledWith("subagent-1", {
      name: "Review Specialist",
      role: "review-specialist",
    });
  });

  it.each([
    ["spec.username", { username: "legacy-subagent" }],
    ["spec.name", { name: "Legacy Subagent" }],
  ])("rejects subagent %s", async (_field, spec) => {
    const api = client();

    await expect(applyResource(api as any, "Subagent", spec, "json", { name: "subagent" })).rejects.toThrow("process.exit");

    expect(api.createSubagent).not.toHaveBeenCalled();
    expect(api.updateSubagent).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("parses subagent metadata from apply files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-apply-subagent-"));
    const file = join(dir, "subagent.yaml");

    try {
      writeFileSync(
        file,
        [
          "kind: Subagent",
          "metadata:",
          "  name: test-specialist",
          "  annotations:",
          "    agent-kanban.dev/nickname: Test Specialist",
          "spec:",
          "  role: test-specialist",
          "  models:",
          "    codex: gpt-5.3-codex",
          "  skills:",
          "    - org/repo@test-skill",
        ].join("\n"),
      );

      expect(parseResourceDocs(file)).toEqual([
        {
          kind: "Subagent",
          metadata: {
            name: "test-specialist",
            annotations: {
              "agent-kanban.dev/nickname": "Test Specialist",
            },
          },
          spec: {
            role: "test-specialist",
            models: {
              codex: "gpt-5.3-codex",
            },
            skills: ["org/repo@test-skill"],
          },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
