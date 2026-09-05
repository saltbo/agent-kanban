// @vitest-environment node

import { createAgencyClient, createAgencySession } from "@server/adapters/agency/client";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agency SDK client", () => {
  it("forwards the exact persisted Session request and launch key with tenant project authority", async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(input instanceof Request ? input : new Request(input, init));
        return Response.json({ uid: "session-1" }, { status: 201 });
      }),
    );
    const client = createAgencyClient("https://enbor.test", { token: "enbor-token", projectId: "project-1" });
    const body = { spec: { agentId: "agent-1" }, prompt: "Claim the assigned Task before executing it." };
    await expect(createAgencySession(client, body, "launch-key-1")).resolves.toEqual({ uid: "session-1" });
    expect(requests[0].url).toBe("https://enbor.test/api/v1/sessions");
    expect(requests[0].headers.get("idempotency-key")).toBe("launch-key-1");
    expect(requests[0].headers.get("x-enbor-project-id")).toBe("project-1");
    expect(requests[0].headers.get("authorization")).toBe("Bearer enbor-token");
    expect(await requests[0].json()).toEqual(body);
  });

  it("preserves Session idempotency conflicts as failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: "idempotency_conflict" }, { status: 409 })),
    );
    const client = createAgencyClient("https://enbor.test", { token: "enbor-token", projectId: "project-1" });
    await expect(createAgencySession(client, { spec: { agentId: "agent-1" }, prompt: "Work" }, "launch-key-1")).rejects.toMatchObject({
      status: 409,
      body: { code: "idempotency_conflict" },
    });
  });

  it("applies a 30 second deadline signal to SDK requests", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(input instanceof Request ? input : new Request(input, init));
        return Response.json({ data: [], pagination: { nextCursor: null } });
      }),
    );
    const client = createAgencyClient("https://enbor.test", { token: "enbor-token", projectId: "project-1" });

    await client.projects.list({ limit: 100 });

    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    controller.abort();
    expect(requests[0]!.signal.aborted).toBe(true);
  });
});
