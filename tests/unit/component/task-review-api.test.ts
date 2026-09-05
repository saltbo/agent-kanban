// @vitest-environment node

import { V2_API_VERSION } from "@shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../src/lib/api";

vi.mock("../../../src/lib/auth-client", () => ({
  getCsrfToken: () => "csrf-token",
  getSession: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Web Task review API", () => {
  it.each([
    ["complete", { status: "done" }, "done"],
    ["reject", { status: "in-progress", statusReason: "needs changes" }, "in_progress"],
  ] as const)("sends a %s status merge patch without reading or supplying an ETag", async (action, patch, expectedStatus) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "task/one", status: patch.status }, { status: 200, headers: { ETag: '"next-task-version"' } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = action === "complete" ? api.tasks.complete("task/one") : api.tasks.reject("task/one", "needs changes");
    await expect(result).resolves.toMatchObject({ id: "task/one", status: expectedStatus });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks/task%2Fone", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/merge-patch+json",
        "API-Version": V2_API_VERSION,
        "x-csrf-token": "csrf-token",
      },
      credentials: "include",
      body: JSON.stringify(patch),
    });
  });
});
