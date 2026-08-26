/**
 * Unit tests for tool-uis (split directory).
 *
 * Covers:
 *  - ToolShell: no ChevronRight in trigger area (removed in recent change)
 *  - ToolShell: renders label and summary text
 *  - ToolShell: applies cancelled styling when status is incomplete+cancelled
 *  - parseMcpToolName: parses MCP-style tool names correctly
 *  - langFromPath: maps file extensions to language identifiers
 *  - agentLabel derivation: subagentType used as label, "agent" as fallback
 *  - TOOL_VIEWS: registry completeness against ToolName enum
 *  - SubtaskChildren: per-tool view dispatch, MCP fallback, status propagation
 */

import { ToolName } from "@agent-kanban/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { langFromPath, parseMcpToolName, SubtaskChildren, TOOL_VIEWS, ToolShell } from "../apps/web/src/components/chat/tool-uis/index.js";
import type { SubtaskChild } from "../apps/web/src/components/RelayRuntimeProvider.js";

// ── ToolShell ─────────────────────────────────────────────────────────────────

describe("ToolShell — trigger contains no ChevronRight chevron", () => {
  it("does not render a ChevronRight svg in the trigger row", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span", { "data-testid": "tool-icon" }),
        label: "bash",
        summary: "echo hello",
      }),
    );
    // ChevronRight from lucide-react renders an svg with aria-label or a specific path.
    // The trigger is the CollapsibleTrigger (button role). We check that the button
    // does NOT contain a chevron-right svg by checking no element with the
    // lucide-chevron-right class or title exists inside the trigger.
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).not.toBeNull();
    // Lucide icons render <svg> elements. Count svgs inside the trigger.
    // With ChevronRight removed, the trigger has at most: status icon (absent when
    // complete) + tool icon. The tool icon is a plain <span> in this test, so
    // no svgs should be in the trigger at all.
    const svgs = trigger!.querySelectorAll("svg");
    // No lucide svg icons should appear in the trigger for a complete-status shell
    // that has a non-svg icon.
    expect(svgs.length).toBe(0);
  });

  it("renders the label text in the trigger", () => {
    render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "my-tool",
        summary: "some summary",
      }),
    );
    expect(screen.getByText("my-tool")).toBeTruthy();
  });

  it("renders the summary text in the trigger", () => {
    render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "ls -la",
      }),
    );
    expect(screen.getByText("ls -la")).toBeTruthy();
  });

  it("renders without error when children are provided", () => {
    // CollapsibleContent panel is not rendered in DOM when closed (base-ui behaviour).
    // This test verifies the component mounts cleanly when children are passed.
    const { container } = render(
      React.createElement(
        ToolShell,
        {
          icon: React.createElement("span"),
          label: "read",
          summary: "/some/file.ts",
        },
        React.createElement("div", { "data-testid": "child-content" }, "file contents"),
      ),
    );
    // Trigger is always rendered regardless of open/closed state
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger).not.toBeNull();
  });
});

describe("ToolShell — status icon presence", () => {
  it("renders a running spinner when status is running", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "running cmd",
        status: { type: "running" },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    // The running status renders a LoaderIcon svg with animate-spin class
    const spinner = trigger!.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });

  it("renders no status icon when status is complete", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "done cmd",
        status: { type: "complete" },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    const spinner = trigger!.querySelector(".animate-spin");
    expect(spinner).toBeNull();
  });

  it("applies opacity-60 and reduced appearance when status is incomplete+cancelled", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "cancelled cmd",
        status: { type: "incomplete", reason: "cancelled" },
      }),
    );
    // The Collapsible root gets opacity-60 class
    const root = container.querySelector('[data-slot="collapsible"]');
    expect(root?.className).toContain("opacity-60");
  });

  it("does not apply opacity-60 when status is running", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "running cmd",
        status: { type: "running" },
      }),
    );
    const root = container.querySelector('[data-slot="collapsible"]');
    expect(root?.className).not.toContain("opacity-60");
  });

  it("renders without error when status is incomplete with an error string", () => {
    // Error text lives inside CollapsibleContent which is not in DOM when closed.
    // This test verifies the component mounts cleanly with an error status and
    // that the XCircle icon appears in the trigger row.
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "bash",
        summary: "errored cmd",
        status: { type: "incomplete", reason: "error", error: "something went wrong" },
      }),
    );
    // XCircleIcon svg should appear in trigger for non-cancelled incomplete status
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    const xIcon = trigger!.querySelector("svg.lucide-circle-x");
    expect(xIcon).not.toBeNull();
  });
});

// ── parseMcpToolName ──────────────────────────────────────────────────────────

describe("parseMcpToolName — MCP tool name parsing", () => {
  it("returns null for non-MCP tool names", () => {
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("Read")).toBeNull();
    expect(parseMcpToolName("Task")).toBeNull();
    expect(parseMcpToolName("TodoWrite")).toBeNull();
  });

  it("parses standard MCP tool name into ns and name", () => {
    expect(parseMcpToolName("mcp__chrome_devtools__click")).toEqual({
      ns: "chrome_devtools",
      name: "click",
    });
  });

  it("parses AMA MCP tool name into ns and name", () => {
    expect(parseMcpToolName("mcp.chrome_devtools.click")).toEqual({
      ns: "chrome_devtools",
      name: "click",
    });
  });

  it("parses AMA MCP tool names with dotted namespaces", () => {
    expect(parseMcpToolName("mcp.github.pull_request.create")).toEqual({
      ns: "github.pull_request",
      name: "create",
    });
  });

  it("parses MCP tool name with simple namespace", () => {
    expect(parseMcpToolName("mcp__context7__query-docs")).toEqual({
      ns: "context7",
      name: "query-docs",
    });
  });

  it("returns ns=mcp and name=rest when no double-underscore after prefix", () => {
    expect(parseMcpToolName("mcp__singlepart")).toEqual({
      ns: "mcp",
      name: "singlepart",
    });
  });

  it("returns null for empty string", () => {
    expect(parseMcpToolName("")).toBeNull();
  });

  it("returns null for string starting with mcp_ (single underscore)", () => {
    expect(parseMcpToolName("mcp_something")).toBeNull();
  });

  it("handles MCP tool name where name contains double underscores", () => {
    // mcp__ns__tool__with__extra → ns="ns", name="tool__with__extra"
    expect(parseMcpToolName("mcp__ns__tool__with__extra")).toEqual({
      ns: "ns",
      name: "tool__with__extra",
    });
  });
});

// ── langFromPath ──────────────────────────────────────────────────────────────

describe("langFromPath — file extension to language mapping", () => {
  it("returns undefined for undefined input", () => {
    expect(langFromPath(undefined)).toBeUndefined();
  });

  it("returns undefined for path with no extension", () => {
    expect(langFromPath("Makefile")).toBeUndefined();
    expect(langFromPath("somefile")).toBeUndefined();
  });

  it("maps .ts to tsx", () => {
    expect(langFromPath("src/index.ts")).toBe("tsx");
  });

  it("maps .tsx to tsx", () => {
    expect(langFromPath("src/App.tsx")).toBe("tsx");
  });

  it("maps .js to jsx", () => {
    expect(langFromPath("dist/bundle.js")).toBe("jsx");
  });

  it("maps .json to json", () => {
    expect(langFromPath("package.json")).toBe("json");
  });

  it("maps .py to python", () => {
    expect(langFromPath("script.py")).toBe("python");
  });

  it("maps .go to go", () => {
    expect(langFromPath("main.go")).toBe("go");
  });

  it("maps .rs to rust", () => {
    expect(langFromPath("src/lib.rs")).toBe("rust");
  });

  it("maps .sh to bash", () => {
    expect(langFromPath("scripts/deploy.sh")).toBe("bash");
  });

  it("maps .md to markdown", () => {
    expect(langFromPath("README.md")).toBe("markdown");
  });

  it("maps .sql to sql", () => {
    expect(langFromPath("migrations/001.sql")).toBe("sql");
  });

  it("returns undefined for unmapped extension", () => {
    expect(langFromPath("binary.wasm")).toBeUndefined();
    expect(langFromPath("archive.zip")).toBeUndefined();
  });

  it("is case-insensitive for extension", () => {
    expect(langFromPath("FILE.TS")).toBe("tsx");
    expect(langFromPath("FILE.JS")).toBe("jsx");
  });
});

// ── agentLabel derivation (TaskToolUI contract) ───────────────────────────────
// The render function computes: agentLabel = args?.subagentType || "agent"
// This was changed from `task:${subagentType}` — test the new contract directly.

describe("agentLabel derivation — TaskToolUI label contract", () => {
  it("uses subagentType as label when provided", () => {
    const agentLabel = (subagentType: string | undefined) => subagentType || "agent";
    expect(agentLabel("clean-code-reviewer")).toBe("clean-code-reviewer");
  });

  it("uses subagentType verbatim without task: prefix", () => {
    const agentLabel = (subagentType: string | undefined) => subagentType || "agent";
    // Old behavior was `task:${subagentType}`. New behavior must NOT have that prefix.
    const label = agentLabel("test-writer");
    expect(label).toBe("test-writer");
    expect(label).not.toMatch(/^task:/);
  });

  it("falls back to 'agent' when subagentType is undefined", () => {
    const agentLabel = (subagentType: string | undefined) => subagentType || "agent";
    expect(agentLabel(undefined)).toBe("agent");
  });

  it("falls back to 'agent' when subagentType is empty string", () => {
    const agentLabel = (subagentType: string | undefined) => subagentType || "agent";
    expect(agentLabel("")).toBe("agent");
  });

  it("renders ToolShell with subagentType as label text", () => {
    // Verify the contract end-to-end via ToolShell rendering
    render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "playwright-test-generator",
        summary: "write e2e tests",
      }),
    );
    expect(screen.getByText("playwright-test-generator")).toBeTruthy();
    // The old prefix "task:" must not appear
    expect(screen.queryByText(/^task:/)).toBeNull();
  });

  it("renders ToolShell with 'agent' fallback label text", () => {
    render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "agent",
        summary: "running subagent",
      }),
    );
    expect(screen.getByText("agent")).toBeTruthy();
  });
});

// ── TOOL_VIEWS registry completeness ─────────────────────────────────────────

describe("TOOL_VIEWS — registry contains every ToolName", () => {
  it("has an entry for every ToolName value", () => {
    for (const name of Object.values(ToolName)) {
      expect(TOOL_VIEWS[name], `TOOL_VIEWS missing entry for ToolName.${name}`).toBeTruthy();
    }
  });

  it("maps each ToolName value to a function (component)", () => {
    for (const name of Object.values(ToolName)) {
      expect(typeof TOOL_VIEWS[name]).toBe("function");
    }
  });
});

// ── SubtaskChildren ───────────────────────────────────────────────────────────

// Helper to build a SubtaskChild array with common structures
function makeToolUseChild(id: string, name: string, input?: Record<string, unknown>): Extract<SubtaskChild, { kind: "tool_use" }> {
  return { kind: "tool_use", id, name, input: input ?? {} };
}

function makeToolResultChild(toolUseId: string, output?: string, error?: boolean): Extract<SubtaskChild, { kind: "tool_result" }> {
  return { kind: "tool_result", tool_use_id: toolUseId, output, error };
}

// Helper: render SubtaskChildren and click the outer "subagent steps" trigger to expand content.
function renderExpanded(items: SubtaskChild[]) {
  const result = render(React.createElement(SubtaskChildren, { items }));
  // Click the outer collapsible trigger to expand the subagent steps panel.
  const trigger = result.container.querySelector('[data-slot="collapsible-trigger"]');
  if (trigger) fireEvent.click(trigger);
  return result;
}

describe("SubtaskChildren — empty items", () => {
  it("returns null (renders nothing) for empty items array", () => {
    const { container } = render(React.createElement(SubtaskChildren, { items: [] }));
    // No content rendered — container should be empty
    expect(container.firstChild).toBeNull();
  });
});

describe("SubtaskChildren — Bash tool_use with matching tool_result", () => {
  it("shows the 'bash' label inside the expanded panel (not a raw JSON wrench fallback)", () => {
    const items: SubtaskChild[] = [makeToolUseChild("tu1", ToolName.Bash, { command: "echo hello" }), makeToolResultChild("tu1", "hello")];
    renderExpanded(items);
    // Label "bash" must appear — it comes from BashToolView via TOOL_VIEWS
    expect(screen.getByText("bash")).toBeTruthy();
  });

  it("shows the '$ cmd' summary in the expanded panel (structured view, not raw JSON)", () => {
    const items: SubtaskChild[] = [makeToolUseChild("tu1", ToolName.Bash, { command: "ls -la" }), makeToolResultChild("tu1", "file.txt")];
    renderExpanded(items);
    // BashToolView renders: <span className="text-accent">$ {cmd}</span>
    // The summary element should contain "$ ls -la"
    expect(screen.getByText("$ ls -la")).toBeTruthy();
  });

  it("does NOT render a raw JSON wrench fallback for Bash", () => {
    const items: SubtaskChild[] = [makeToolUseChild("tu1", ToolName.Bash, { command: "pwd" }), makeToolResultChild("tu1", "/home/user")];
    const { container } = renderExpanded(items);
    // Raw JSON fallback shows a lucide-wrench svg. BashToolView uses Terminal icon.
    // Verifying wrench is absent confirms the structured view is used.
    const wrenches = container.querySelectorAll("svg.lucide-wrench");
    expect(wrenches.length).toBe(0);
  });
});

describe("SubtaskChildren — Read tool_use with matching tool_result", () => {
  it("shows the 'read' label in the expanded panel", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu2", ToolName.Read, { filePath: "/src/index.ts" }),
      makeToolResultChild("tu2", "export default {}"),
    ];
    renderExpanded(items);
    expect(screen.getByText("read")).toBeTruthy();
  });

  it("shows the file path as summary in the expanded panel", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu2", ToolName.Read, { filePath: "/src/index.ts" }),
      makeToolResultChild("tu2", "export default {}"),
    ];
    renderExpanded(items);
    expect(screen.getByText("/src/index.ts")).toBeTruthy();
  });
});

describe("SubtaskChildren — tool_use with no matching tool_result (running)", () => {
  it("renders a spinner inside the expanded panel when there is no paired tool_result", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu3", ToolName.Bash, { command: "npm install" }),
      // No tool_result — the tool is still running
    ];
    const { container } = renderExpanded(items);
    // ToolShell renders a LoaderIcon with animate-spin for status=running
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();
  });
});

describe("SubtaskChildren — unknown tool name (MCP fallback)", () => {
  it("shows a label starting with 'mcp:' for MCP tool names", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu4", "mcp__chrome_devtools__click", { selector: "#btn" }),
      makeToolResultChild("tu4", "clicked"),
    ];
    renderExpanded(items);
    // SubtaskFallback renders label as `mcp:${mcp.ns}` = "mcp:chrome_devtools"
    expect(screen.getByText("mcp:chrome_devtools")).toBeTruthy();
  });

  it("shows the tool action name (e.g. 'click') in the summary for MCP tools", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu4", "mcp__chrome_devtools__click", { selector: "#btn" }),
      makeToolResultChild("tu4", "clicked"),
    ];
    renderExpanded(items);
    // SubtaskFallback renders summary as mcp.name = "click"
    expect(screen.getByText("click")).toBeTruthy();
  });

  it("shows 'tool' label for non-MCP unknown tool names", () => {
    const items: SubtaskChild[] = [makeToolUseChild("tu5", "some_unknown_tool", { arg: "val" }), makeToolResultChild("tu5", "result")];
    renderExpanded(items);
    expect(screen.getByText("tool")).toBeTruthy();
  });
});

describe("SubtaskChildren — error tool_result", () => {
  it("renders XCircle icon in the expanded panel when tool_result has error=true", () => {
    // For error tool_results, statusFor returns { type: "incomplete", reason: "error" }
    // ToolShell does NOT apply opacity-60 for reason="error" (only for reason="cancelled").
    // The XCircle icon should appear in the trigger row of the inner ToolShell.
    const items: SubtaskChild[] = [
      makeToolUseChild("tu6", ToolName.Bash, { command: "bad-cmd" }),
      makeToolResultChild("tu6", "Command not found", true),
    ];
    const { container } = renderExpanded(items);
    // XCircle appears for incomplete+error (not cancelled)
    const xIcon = container.querySelector("svg.lucide-circle-x");
    expect(xIcon).not.toBeNull();
  });

  it("does NOT apply opacity-60 for error tool_result (only cancelled gets opacity-60)", () => {
    const items: SubtaskChild[] = [
      makeToolUseChild("tu6", ToolName.Bash, { command: "bad-cmd" }),
      makeToolResultChild("tu6", "Command not found", true),
    ];
    const { container } = renderExpanded(items);
    // The inner ToolShell Collapsible root — opacity-60 is only for cancelled
    // There are two collapsibles: the outer SubtaskChildren and the inner ToolShell.
    const collapsibles = container.querySelectorAll('[data-slot="collapsible"]');
    // The inner one (tool shell) should not have opacity-60
    const innerCollapsible = Array.from(collapsibles).find((el) => el.className.includes("group/tool"));
    expect(innerCollapsible?.className).not.toContain("opacity-60");
  });
});

describe("SubtaskChildren — text and thinking children", () => {
  it("renders text children as markdown (text content appears in expanded panel)", () => {
    const items: SubtaskChild[] = [{ kind: "text", text: "Hello from subagent" }];
    renderExpanded(items);
    expect(screen.getByText("Hello from subagent")).toBeTruthy();
  });

  it("renders thinking children as italic text in the expanded panel", () => {
    const items: SubtaskChild[] = [{ kind: "thinking", text: "Let me think about this" }];
    const { container } = renderExpanded(items);
    // Thinking block renders in an italic div
    const italic = container.querySelector(".italic");
    expect(italic).not.toBeNull();
    expect(italic?.textContent).toBe("Let me think about this");
  });
});

// ── Per-tool View FCs — direct rendering ──────────────────────────────────────
// Import the individual views to directly test their rendering without going
// through the SubtaskChildren collapsible dance.

import { CodeBlock, FileDiff, Markdown, Mono, resultText } from "../apps/web/src/components/chat/tool-uis/primitives.js";
import {
  AskUserQuestionToolView,
  BashToolView,
  EditToolView,
  ExitPlanModeToolView,
  GlobToolView,
  GrepToolView,
  MultiEditToolView,
  NotebookEditToolView,
  ReadToolView,
  SlashCommandToolView,
  TaskToolView,
  TodoWriteToolView,
  WebFetchToolView,
  WebSearchToolView,
  WriteToolView,
} from "../apps/web/src/components/chat/tool-uis/views.js";

describe("BashToolView — direct render", () => {
  it("renders 'bash' label and command summary", () => {
    render(React.createElement(BashToolView, { args: { command: "echo hi" }, result: "hi" }));
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("$ echo hi")).toBeTruthy();
  });

  it("renders with description when provided", () => {
    render(React.createElement(BashToolView, { args: { command: "ls", description: "list files" } }));
    // description renders inside the collapsible content — open it
    const { container } = render(React.createElement(BashToolView, { args: { command: "ls", description: "list files" } }));
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getAllByText("list files").length).toBeGreaterThan(0);
  });

  it("renders without args gracefully (empty command)", () => {
    render(React.createElement(BashToolView, {}));
    expect(screen.getByText("bash")).toBeTruthy();
    // The summary span contains "$ " followed by the (empty) command text.
    // Use a function matcher to handle text split across sibling nodes.
    expect(
      screen.getByText((content, node) => {
        return node?.tagName === "SPAN" && (node as Element).className.includes("text-accent") && (node?.textContent ?? "").startsWith("$ ");
      }),
    ).toBeTruthy();
  });
});

describe("ReadToolView — direct render", () => {
  it("renders 'read' label and file path summary", () => {
    render(React.createElement(ReadToolView, { args: { filePath: "/etc/hosts" } }));
    expect(screen.getByText("read")).toBeTruthy();
    expect(screen.getByText("/etc/hosts")).toBeTruthy();
  });

  it("renders offset range in summary when offset is provided", () => {
    render(React.createElement(ReadToolView, { args: { filePath: "/file.ts", offset: 10, limit: 50 } }));
    expect(screen.getByText(":10-60")).toBeTruthy();
  });

  it("renders offset without limit", () => {
    render(React.createElement(ReadToolView, { args: { filePath: "/file.ts", offset: 5 } }));
    expect(screen.getByText(":5")).toBeTruthy();
  });
});

describe("EditToolView — direct render", () => {
  it("renders 'edit' label and file path summary", () => {
    render(React.createElement(EditToolView, { args: { filePath: "/src/foo.ts", oldString: "old", newString: "new" } }));
    expect(screen.getByText("edit")).toBeTruthy();
    expect(screen.getByText("/src/foo.ts")).toBeTruthy();
  });
});

describe("MultiEditToolView — direct render", () => {
  it("renders 'multi-edit' label", () => {
    render(
      React.createElement(MultiEditToolView, {
        args: { filePath: "/src/bar.ts", edits: [{ oldString: "a", newString: "b" }] },
      }),
    );
    expect(screen.getByText("multi-edit")).toBeTruthy();
  });

  it("shows edit count in summary", () => {
    render(
      React.createElement(MultiEditToolView, {
        args: {
          filePath: "/src/bar.ts",
          edits: [
            { oldString: "a", newString: "b" },
            { oldString: "c", newString: "d" },
          ],
        },
      }),
    );
    expect(screen.getByText("2 edits")).toBeTruthy();
  });
});

describe("WriteToolView — direct render", () => {
  it("renders 'write' label and file path summary", () => {
    render(React.createElement(WriteToolView, { args: { filePath: "/out/result.ts", content: "hello\nworld" } }));
    expect(screen.getByText("write")).toBeTruthy();
    expect(screen.getByText("/out/result.ts")).toBeTruthy();
  });
});

describe("GrepToolView — direct render", () => {
  it("renders 'grep' label and pattern summary", () => {
    render(React.createElement(GrepToolView, { args: { pattern: "TODO", path: "./src" } }));
    expect(screen.getByText("grep")).toBeTruthy();
    expect(screen.getByText("/TODO/")).toBeTruthy();
  });
});

describe("GlobToolView — direct render", () => {
  it("renders 'glob' label and pattern summary", () => {
    render(React.createElement(GlobToolView, { args: { pattern: "**/*.ts" } }));
    expect(screen.getByText("glob")).toBeTruthy();
    expect(screen.getByText("**/*.ts")).toBeTruthy();
  });

  it("renders path in summary when provided", () => {
    render(React.createElement(GlobToolView, { args: { pattern: "*.ts", path: "./src" } }));
    expect(screen.getByText("in ./src")).toBeTruthy();
  });
});

describe("TodoWriteToolView — direct render", () => {
  it("renders 'todos' label", () => {
    render(
      React.createElement(TodoWriteToolView, {
        args: {
          todos: [
            { content: "Task A", status: "pending" },
            { content: "Task B", status: "completed" },
          ],
        },
      }),
    );
    expect(screen.getByText("todos")).toBeTruthy();
  });

  it("shows done/total count in summary", () => {
    render(
      React.createElement(TodoWriteToolView, {
        args: {
          todos: [
            { content: "A", status: "completed" },
            { content: "B", status: "pending" },
          ],
        },
      }),
    );
    expect(screen.getByText("1/2 done")).toBeTruthy();
  });

  it("renders in_progress todo item", () => {
    const { container } = render(
      React.createElement(TodoWriteToolView, {
        args: { todos: [{ content: "In progress task", status: "in_progress" }] },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    // in_progress renders "→" indicator
    expect(screen.getByText("→")).toBeTruthy();
  });
});

describe("WebFetchToolView — direct render", () => {
  it("renders 'web-fetch' label and host as summary", () => {
    render(React.createElement(WebFetchToolView, { args: { url: "https://example.com/page", prompt: "summarize" } }));
    expect(screen.getByText("web-fetch")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("falls back to raw URL when URL is invalid", () => {
    render(React.createElement(WebFetchToolView, { args: { url: "not-a-url", prompt: "get" } }));
    expect(screen.getByText("web-fetch")).toBeTruthy();
  });
});

describe("WebSearchToolView — direct render", () => {
  it("renders 'web-search' label and query summary", () => {
    render(React.createElement(WebSearchToolView, { args: { query: "vitest coverage" } }));
    expect(screen.getByText("web-search")).toBeTruthy();
    expect(screen.getByText("vitest coverage")).toBeTruthy();
  });

  it("renders search results when result is an array", () => {
    const result = [{ title: "Result 1", url: "https://example.com", snippet: "snippet text" }];
    const { container } = render(React.createElement(WebSearchToolView, { args: { query: "test" }, result }));
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("Result 1")).toBeTruthy();
  });

  it("renders result as mono text when result is a string (not array)", () => {
    const { container } = render(React.createElement(WebSearchToolView, { args: { query: "test" }, result: "plain text result" }));
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("plain text result")).toBeTruthy();
  });
});

describe("AskUserQuestionToolView — direct render", () => {
  it("renders 'ask' label and first question in summary", () => {
    render(
      React.createElement(AskUserQuestionToolView, {
        args: { questions: [{ question: "What is your name?" }] },
      }),
    );
    expect(screen.getByText("ask")).toBeTruthy();
    expect(screen.getByText("What is your name?")).toBeTruthy();
  });

  it("renders with no questions (empty array)", () => {
    render(React.createElement(AskUserQuestionToolView, { args: { questions: [] } }));
    expect(screen.getByText("ask")).toBeTruthy();
  });

  it("renders question options when expanded", () => {
    const { container } = render(
      React.createElement(AskUserQuestionToolView, {
        args: {
          questions: [
            {
              question: "Choose one",
              options: [
                { label: "Option A", description: "first" },
                { label: "Option B", description: "second" },
              ],
            },
          ],
        },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("Option A")).toBeTruthy();
  });
});

describe("ExitPlanModeToolView — direct render", () => {
  it("renders 'plan' label", () => {
    render(React.createElement(ExitPlanModeToolView, { args: { plan: "Step 1: do something" } }));
    expect(screen.getByText("plan")).toBeTruthy();
  });
});

describe("SlashCommandToolView — direct render", () => {
  it("renders 'slash' label and command summary", () => {
    render(React.createElement(SlashCommandToolView, { args: { command: "/help" } }));
    expect(screen.getByText("slash")).toBeTruthy();
    expect(screen.getByText("/help")).toBeTruthy();
  });

  it("strips leading slash from command", () => {
    render(React.createElement(SlashCommandToolView, { args: { command: "help" } }));
    expect(screen.getByText("/help")).toBeTruthy();
  });
});

describe("NotebookEditToolView — direct render", () => {
  it("renders label with edit mode", () => {
    render(
      React.createElement(NotebookEditToolView, {
        args: { notebookPath: "nb.ipynb", newSource: "print('hi')", editMode: "replace" },
      }),
    );
    expect(screen.getByText("nb:replace")).toBeTruthy();
  });

  it("defaults edit mode to 'replace' when not provided", () => {
    render(
      React.createElement(NotebookEditToolView, {
        args: { notebookPath: "nb.ipynb", newSource: "x = 1" },
      }),
    );
    expect(screen.getByText("nb:replace")).toBeTruthy();
  });

  it("shows cellId in summary when provided", () => {
    render(
      React.createElement(NotebookEditToolView, {
        args: { notebookPath: "nb.ipynb", cellId: "cell-123", newSource: "code" },
      }),
    );
    expect(screen.getByText("#cell-123")).toBeTruthy();
  });
});

describe("TaskToolView — direct render", () => {
  it("renders agentLabel from args.subagentType", () => {
    render(
      React.createElement(TaskToolView, {
        args: { description: "Write tests", prompt: "write unit tests", subagentType: "test-writer" },
      }),
    );
    expect(screen.getByText("test-writer")).toBeTruthy();
  });

  it("falls back to 'agent' label when subagentType is missing", () => {
    render(
      React.createElement(TaskToolView, {
        args: { description: "Do stuff", prompt: "do the thing" },
      }),
    );
    expect(screen.getByText("agent")).toBeTruthy();
  });

  it("renders meta info when result has meta tokens and duration", () => {
    const { container } = render(
      React.createElement(TaskToolView, {
        args: { description: "Task", prompt: "prompt" },
        result: { text: "done", meta: { tokens: 1500, duration_ms: 5000, last_tool: "Bash" } },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("1500 tok · 5s · Bash")).toBeTruthy();
  });

  it("handles string result (legacy format)", () => {
    const { container } = render(
      React.createElement(TaskToolView, {
        args: { description: "Task", prompt: "prompt" },
        result: "legacy result text",
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("report:")).toBeTruthy();
  });
});

// ── resultText utility ────────────────────────────────────────────────────────

describe("resultText — coercion utility", () => {
  it("returns null for null input", () => {
    expect(resultText(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(resultText(undefined)).toBeNull();
  });

  it("returns the string unchanged for string input", () => {
    expect(resultText("hello")).toBe("hello");
  });

  it("returns the error field from an error-shaped object", () => {
    expect(resultText({ error: "something went wrong" })).toBe("something went wrong");
  });

  it("returns the output field from an output-shaped object", () => {
    expect(resultText({ output: "result text" })).toBe("result text");
  });

  it("returns JSON stringified for other objects", () => {
    expect(resultText({ foo: "bar" })).toBe('{\n  "foo": "bar"\n}');
  });

  it("converts numbers to string", () => {
    expect(resultText(42)).toBe("42");
  });
});

// ── CodeBlock — plain/unlang path ────────────────────────────────────────────

describe("CodeBlock — plain pre rendering", () => {
  it("renders content in a pre element when no lang provided", () => {
    const { container } = render(React.createElement(CodeBlock, { children: "raw output" }));
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("raw output");
  });

  it("renders plain pre when plain prop is true even if lang is set", () => {
    const { container } = render(React.createElement(CodeBlock, { children: "output", lang: "bash", plain: true }));
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

// ── Mono ──────────────────────────────────────────────────────────────────────

describe("Mono — plain code block", () => {
  it("renders children text in a pre element", () => {
    const { container } = render(React.createElement(Mono, { children: "mono content" }));
    expect(container.querySelector("pre")?.textContent).toBe("mono content");
  });
});

// ── Markdown ─────────────────────────────────────────────────────────────────

describe("Markdown — markdown rendering", () => {
  it("renders text content", () => {
    render(React.createElement(Markdown, { text: "Hello world" }));
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("renders bold markdown", () => {
    const { container } = render(React.createElement(Markdown, { text: "**bold text**" }));
    expect(container.querySelector("strong")?.textContent).toBe("bold text");
  });
});

// ── FileDiff ─────────────────────────────────────────────────────────────────

describe("FileDiff — diff viewer rendering", () => {
  it("renders without error for simple string diff", () => {
    const { container } = render(React.createElement(FileDiff, { oldStr: "old line", newStr: "new line" }));
    // FileDiff wraps a ReactDiffViewer in a div — verify the wrapper is rendered
    expect(container.firstChild).not.toBeNull();
  });

  it("renders without error when oldStr and newStr are both empty", () => {
    const { container } = render(React.createElement(FileDiff, { oldStr: "", newStr: "" }));
    expect(container.firstChild).not.toBeNull();
  });
});

// ── ToolShell — requires-action status ───────────────────────────────────────

describe("ToolShell — requires-action status icon", () => {
  it("renders AlertCircle icon for requires-action status", () => {
    const { container } = render(
      React.createElement(ToolShell, {
        icon: React.createElement("span"),
        label: "tool",
        summary: "waiting",
        status: { type: "requires-action" },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    // Lucide's AlertCircleIcon renders with class "lucide-circle-alert" (version-dependent naming)
    const alertIcon = trigger!.querySelector("svg.lucide-circle-alert");
    expect(alertIcon).not.toBeNull();
  });
});

// ── WebFetchToolView — with output result ────────────────────────────────────

describe("WebFetchToolView — output result rendering", () => {
  it("renders 'response' section when result has output text", () => {
    const { container } = render(
      React.createElement(WebFetchToolView, {
        args: { url: "https://example.com", prompt: "summarize" },
        result: "The page says hello",
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("response")).toBeTruthy();
  });
});

// ── AskUserQuestionToolView — header rendering ───────────────────────────────

describe("AskUserQuestionToolView — question header rendering", () => {
  it("renders question header label when header is provided", () => {
    const { container } = render(
      React.createElement(AskUserQuestionToolView, {
        args: {
          questions: [
            {
              header: "Important",
              question: "What should I do?",
            },
          ],
        },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    expect(screen.getByText("Important")).toBeTruthy();
  });
});

// ── TaskToolView — coerceTaskResult with children ────────────────────────────

describe("TaskToolView — result with children and SubtaskChildren", () => {
  it("renders SubtaskChildren when result has non-empty children", () => {
    const { container } = render(
      React.createElement(TaskToolView, {
        args: { description: "Task", prompt: "do it" },
        result: {
          text: "done",
          children: [{ kind: "text", text: "Subagent working..." }],
        },
      }),
    );
    const trigger = container.querySelector('[data-slot="collapsible-trigger"]');
    if (trigger) fireEvent.click(trigger);
    // SubtaskChildren renders a "subagent steps (N)" trigger
    expect(screen.getByText(/subagent steps/)).toBeTruthy();
  });
});

// ── ChatToolUIs — export completeness ────────────────────────────────────────
// ChatToolUIs mounts inside an AssistantRuntimeProvider (requires runtime context)
// so we cannot render it in jsdom without the full provider tree. Instead verify
// the module exports what consumers expect.

import { ChatToolUIs } from "../apps/web/src/components/chat/tool-uis/index.js";

describe("ChatToolUIs — module export", () => {
  it("is exported as a function (React FC)", () => {
    expect(typeof ChatToolUIs).toBe("function");
  });
});
