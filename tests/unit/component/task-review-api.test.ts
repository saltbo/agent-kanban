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
  it("reads the current submission ETag before replacing a Task Review Completion", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "submission-one", taskId: "task/one" }, { status: 200, headers: { ETag: '"submission-version"' } }))
      .mockResolvedValueOnce(Response.json({ id: "completion-one" }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.tasks.complete("task/one")).resolves.toEqual({ id: "completion-one" });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/task-review-submissions/task%2Fone", {
      headers: { "API-Version": V2_API_VERSION },
      credentials: "include",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/task-review-completions/task%2Fone", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "API-Version": V2_API_VERSION,
        "x-csrf-token": "csrf-token",
      },
      credentials: "include",
      body: JSON.stringify({ reviewSubmissionVersion: "submission-version" }),
    });
  });
});
