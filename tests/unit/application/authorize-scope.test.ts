import { describe, expect, it, vi } from "vitest";
import { authorizeScope } from "../../../server/auth/middleware";
import type { RealmrootPrincipal } from "../../../server/auth/realmroot";

describe("authorizeScope", () => {
  it.each([
    ["session", "human"],
    ["token", "human"],
    ["token", "agent"],
    ["token", "service"],
  ] as const)("allows a %s %s principal solely from its granted scope", async (source, type) => {
    const next = vi.fn(async () => undefined);
    const context = contextWith({ source, type, scopes: ["task:read"] });

    await authorizeScope("task:read")(context, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("returns RFC Problem 403 when the principal lacks the required scope", async () => {
    const next = vi.fn(async () => undefined);
    const context = contextWith({ source: "session", type: "human", scopes: ["board:read"] });

    const response = await authorizeScope("task:read")(context, next);

    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toContain("application/problem+json");
    await expect(response?.json()).resolves.toMatchObject({
      title: "Permission denied",
      status: 403,
      detail: "Missing scope: task:read",
    });
    expect(next).not.toHaveBeenCalled();
  });
});

function contextWith(input: Pick<RealmrootPrincipal, "source" | "type" | "scopes">): Parameters<ReturnType<typeof authorizeScope>>[0] {
  const values: Record<string, unknown> = {
    principal: {
      ...input,
      subjectId: "subject-1",
      tenantId: "tenant-1",
    },
    requestId: "request-1",
  };
  return {
    req: { method: "GET", path: "/api/tasks", url: "https://agent-kanban.test/api/tasks" },
    get(key: string) {
      return values[key];
    },
    json(body: unknown, status: number, headers: HeadersInit) {
      return Response.json(body, { status, headers });
    },
  } as Parameters<ReturnType<typeof authorizeScope>>[0];
}
