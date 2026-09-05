import { normalizeTaskCreate, normalizeTaskUpdate } from "@server/http/tasks/request";
import { describe, expect, it } from "vitest";

describe("server-owned Task execution annotations", () => {
  it.each([
    { "agent-kanban.dev/launch": { state: "started" } },
    { "agent-kanban.dev/launch": null },
    { annotations: { "agent-kanban.dev/session-id": "forged-session" } },
    { annotations: { "agent-kanban.dev/session-id": null } },
    { annotations: null },
    { annotations: "replace-container" },
  ])("[spec: tasks/launch-request-binding] rejects forged or removed execution metadata: %j", (metadata) => {
    expect(() => normalizeTaskCreate({ title: "Task", metadata })).toThrow();
    expect(() => normalizeTaskUpdate({ metadata })).toThrow();
  });
  it("[spec: tasks/launch-request-binding] allows unrelated annotations", () => {
    expect(() => normalizeTaskUpdate({ metadata: { annotations: { "example.com/ticket": "issue-1" } } })).not.toThrow();
  });
});
