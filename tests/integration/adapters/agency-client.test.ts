// @vitest-environment node

import { createAgencyClient } from "@server/adapters/agency/client";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agency SDK client", () => {
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
