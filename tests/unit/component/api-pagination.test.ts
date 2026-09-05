// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/lib/api";

vi.mock("../../../src/lib/auth-client", () => ({
  getCsrfToken: () => "csrf-token",
  getSession: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

const collections = [
  {
    name: "tasks",
    path: "/api/tasks",
    read: () => api.tasks.list({ board_id: "board-1", assigned_to: "agent-1", status: "todo" }),
    filters: { boardId: "board-1", assignedTo: "agent-1", status: "todo" },
    field: "boardId",
    mapped: "board_id",
  },
  { name: "boards", path: "/api/boards", read: () => api.boards.list(), filters: {}, field: "ownerId", mapped: "owner_id" },
  { name: "repositories", path: "/api/repositories", read: () => api.repositories.list(), filters: {}, field: "fullName", mapped: "full_name" },
  {
    name: "notes",
    path: "/api/tasks/task-1/notes",
    read: () => api.tasks.getNotes("task-1", "2026-09-01T12:00:00Z"),
    filters: { since: "2026-09-01T12:00:00Z" },
    field: "taskId",
    mapped: "task_id",
  },
];

describe("Browser collection pagination", () => {
  it.each(collections)(
    "[spec: resource-server/generic-operations] returns every $name page with its filters and field mappings",
    async ({ path, read, filters, field, mapped }) => {
      const seen: URL[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url = new URL(String(input), "https://ak.test");
          seen.push(url);
          expect(url.pathname).toBe(path);
          expect(Object.fromEntries([...url.searchParams].filter(([key]) => key !== "pageToken"))).toEqual(filters);
          const token = url.searchParams.get("pageToken");
          if (token === null)
            return Response.json({ items: [{ id: "first", [field]: "first-value" }], pagination: { pageSize: 1, nextPageToken: "next+/=" } });
          expect(token).toBe("next+/=");
          return Response.json({ items: [{ id: "last", [field]: "last-value" }], pagination: { pageSize: 1 } });
        }),
      );

      const result = await read();
      expect(result.map((item: any) => ({ id: item.id, value: item[mapped] }))).toEqual([
        { id: "first", value: "first-value" },
        { id: "last", value: "last-value" },
      ]);
      expect(seen).toHaveLength(2);
    },
  );

  it("[spec: resource-server/generic-operations] rejects a later page failure instead of returning an incomplete collection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ items: [{ id: "first" }], pagination: { pageSize: 1, nextPageToken: "next" } }))
        .mockResolvedValueOnce(Response.json({ type: "https://ak.test/problems/unavailable", detail: "Collection unavailable" }, { status: 503 })),
    );

    await expect(api.boards.list()).rejects.toMatchObject({ message: "Collection unavailable", status: 503 });
  });
});
