import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ActivityLog } from "@/features/tasks/components/ActivityLog";
import { TaskCard } from "@/features/tasks/components/TaskCard";

describe("TaskCard activity entry point", () => {
  it("stops card navigation when the assigned Realmroot Agent is clicked", () => {
    const task = {
      id: "task-1",
      seq: 17,
      title: "Improve activity",
      status: "in_progress",
      labels: ["frontend"],
      assigned_to: "agent-subject-1",
      assignee_identity_type: "realmroot_actor",
      assignee_name: "flint",
      glow_suppressed: false,
    };
    const onClick = vi.fn();
    const onAgentClick = vi.fn();

    render(<TaskCard task={task} onClick={onClick} onAgentClick={onAgentClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat with flint" }));

    expect(onAgentClick).toHaveBeenCalledWith(task);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Task ActivityLog", () => {
  it("merges notes oldest-to-newest and removes a duplicate SSE note", () => {
    const { container } = render(
      <ActivityLog
        reconnecting={false}
        initialNotes={[
          note({
            id: "newer",
            action: "completed",
            actor_name: "Lead",
            created_at: "2026-05-04T10:03:00.000Z",
          }),
          note({
            id: "older",
            action: "created",
            actor_name: "Lead",
            created_at: "2026-05-04T10:01:00.000Z",
          }),
        ]}
        sseNotes={[
          note({
            id: "newer",
            action: "completed",
            actor_name: "Lead",
            created_at: "2026-05-04T10:03:00.000Z",
          }),
          note({
            id: "middle",
            action: "claimed",
            actor_name: "flint",
            actor_type: "realmroot:agent",
            created_at: "2026-05-04T10:02:00.000Z",
          }),
        ]}
      />,
    );

    const text = container.textContent ?? "";
    expect(screen.getAllByText("Lead")).toHaveLength(2);
    expect(text.indexOf("created this task")).toBeLessThan(text.indexOf("claimed this task"));
    expect(text.indexOf("claimed this task")).toBeLessThan(text.indexOf("completed this task"));
  });

  it("does not create a nested vertical scroll region", () => {
    render(<ActivityLog reconnecting={false} initialNotes={[note({ id: "created", action: "created" })]} sseNotes={[]} />);

    const liveRegion = screen.getByText("created this task").closest("[aria-live='polite']");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.className).not.toContain("overflow-y-auto");
    expect(liveRegion?.className).not.toContain("max-h-");
  });

  it("renders Realmroot Agent comments as GitHub-style Markdown", () => {
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
      <ActivityLog
        reconnecting={false}
        initialNotes={[
          note({
            action: "commented",
            detail: markdown,
            actor_id: "agent-subject-1",
            actor_name: "flint",
            actor_type: "realmroot:agent",
          }),
        ]}
        sseNotes={[]}
      />,
    );

    expect(screen.getByText("flint")).toBeTruthy();
    expect(screen.getByText("commented")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Review notes" })).toBeTruthy();
    expect(screen.getByText("Render")).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR" }).getAttribute("href")).toBe("https://example.com/pr/1");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByText("quoted feedback").closest("blockquote")).toBeTruthy();
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
    actor_id: "user-subject-1",
    actor_type: "user",
    actor_name: "Lead",
    created_at: "2026-05-04T10:00:00.000Z",
    ...overrides,
  };
}
