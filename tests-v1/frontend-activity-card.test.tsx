import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ActivityLog } from "../apps/web/src/components/ActivityLog.js";
import { TaskCard } from "../apps/web/src/components/TaskCard.js";

describe("TaskCard agent click", () => {
  it("opens agent task chat without opening the card detail", () => {
    const task = {
      id: "task-1",
      seq: 17,
      title: "Improve activity",
      status: "in_progress",
      labels: ["frontend"],
      assigned_to: "agent-1",
      agent_name: "flint",
      agent_public_key: "agent-public-key",
      glow_suppressed: false,
    };
    const onClick = vi.fn();
    const onAgentClick = vi.fn();

    render(React.createElement(TaskCard, { task, onClick, onAgentClick }));

    fireEvent.click(screen.getByText("flint"));

    expect(onAgentClick).toHaveBeenCalledWith(task);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens task detail when the card body is clicked", () => {
    const task = {
      id: "task-2",
      seq: 18,
      title: "Open details",
      status: "todo",
      labels: [],
      assigned_to: "agent-2",
      agent_name: "worker",
    };
    const onClick = vi.fn();

    render(React.createElement(TaskCard, { task, onClick }));

    fireEvent.click(screen.getByText("Open details"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("ActivityLog", () => {
  it("renders merged notes oldest-to-newest and removes duplicate SSE notes", () => {
    const { container } = render(
      React.createElement(ActivityLog, {
        reconnecting: false,
        initialNotes: [
          note({ id: "newer", action: "completed", actor_name: "Lead", created_at: "2026-05-04T10:03:00.000Z" }),
          note({ id: "older", action: "created", actor_name: "Lead", created_at: "2026-05-04T10:01:00.000Z" }),
        ],
        sseNotes: [
          note({ id: "newer", action: "completed", actor_name: "Lead", created_at: "2026-05-04T10:03:00.000Z" }),
          note({ id: "middle", action: "claimed", actor_name: "flint", created_at: "2026-05-04T10:02:00.000Z" }),
        ],
      }),
    );

    const text = container.textContent ?? "";

    expect(screen.getAllByText("Lead")).toHaveLength(2);
    expect(text.indexOf("created this task")).toBeLessThan(text.indexOf("claimed this task"));
    expect(text.indexOf("claimed this task")).toBeLessThan(text.indexOf("completed this task"));
  });

  it("does not create an inner scroll region", () => {
    render(
      React.createElement(ActivityLog, {
        reconnecting: false,
        initialNotes: [note({ id: "older", action: "created", created_at: "2026-05-04T10:01:00.000Z" })],
        sseNotes: [],
      }),
    );

    const liveRegion = screen.getByText("created this task").closest("[aria-live='polite']");

    expect(liveRegion?.className).not.toContain("overflow-y-auto");
    expect(liveRegion?.className).not.toContain("max-h-");
  });

  it("renders comment detail as GitHub-style markdown content", () => {
    const markdown = [
      "## Review notes",
      "",
      "- Render **markdown**",
      "- Link to [PR](https://example.com/pr/1)",
      "",
      "`inline code`",
      "",
      "> quoted feedback",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| status | pass |",
      "",
      "```ts",
      "const ok = true;",
      "```",
    ].join("\n");

    const { container } = render(
      React.createElement(ActivityLog, {
        reconnecting: false,
        initialNotes: [note({ action: "commented", detail: markdown, actor_name: "flint" })],
        sseNotes: [],
      }),
    );

    expect(screen.getByText("flint")).toBeTruthy();
    expect(screen.getByText("commented")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review notes" })).toBeTruthy();
    expect(screen.getByText("Render")).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR" }).getAttribute("href")).toBe("https://example.com/pr/1");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByText("quoted feedback").closest("blockquote")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("status")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toContain("const ok = true;");
  });
});

function note(overrides: Record<string, unknown>) {
  return {
    id: "note-1",
    task_id: "task-1",
    action: "created",
    detail: null,
    actor_type: "user",
    actor_name: "Lead",
    actor_public_key: null,
    created_at: "2026-05-04T10:00:00.000Z",
    ...overrides,
  };
}
