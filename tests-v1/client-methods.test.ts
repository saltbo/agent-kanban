// @vitest-environment node
import { describe, expect, it } from "vitest";

/**
 * Tests that the new ApiClient methods exist and have the correct arity.
 * These are contract tests — they verify the public interface without
 * invoking live HTTP calls.
 */
describe("ApiClient new methods — public contract", () => {
  it("deleteTask is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).deleteTask).toBe("function");
  });

  it("deleteTask accepts one argument (task id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).deleteTask.length).toBe(1);
  });

  it("rejectTask is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).rejectTask).toBe("function");
  });

  it("rejectTask accepts an id and an optional body", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    // First param is id; second (body) has a default value so length >= 1
    expect((ApiClient.prototype as any).rejectTask.length).toBeGreaterThanOrEqual(1);
  });

  it("getTaskNotes is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).getTaskNotes).toBe("function");
  });

  it("getTaskNotes accepts taskId as first parameter", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).getTaskNotes.length).toBeGreaterThanOrEqual(1);
  });

  it("deleteAgent is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).deleteAgent).toBe("function");
  });

  it("deleteAgent accepts one argument (agent id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).deleteAgent.length).toBe(1);
  });

  it("updateBoard is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).updateBoard).toBe("function");
  });

  it("updateBoard accepts boardId and body", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).updateBoard.length).toBe(2);
  });

  it("deleteBoard is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).deleteBoard).toBe("function");
  });

  it("deleteBoard accepts one argument (board id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).deleteBoard.length).toBe(1);
  });

  it("deleteRepository is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).deleteRepository).toBe("function");
  });

  it("deleteRepository accepts one argument (repo id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).deleteRepository.length).toBe(1);
  });

  it("getAgent is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).getAgent).toBe("function");
  });

  it("getAgent accepts one argument (agent id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).getAgent.length).toBe(1);
  });

  it("listSubagents is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).listSubagents).toBe("function");
  });

  it("listSubagents accepts no arguments", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).listSubagents.length).toBe(0);
  });

  it("getSubagent is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).getSubagent).toBe("function");
  });

  it("getSubagent accepts one argument (subagent id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).getSubagent.length).toBe(1);
  });

  it("deleteSubagent is a function on ApiClient", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect(typeof (ApiClient.prototype as any).deleteSubagent).toBe("function");
  });

  it("deleteSubagent accepts one argument (subagent id)", async () => {
    const { ApiClient } = await import("../packages/cli/src/client/index");
    expect((ApiClient.prototype as any).deleteSubagent.length).toBe(1);
  });
});

describe("ApiError", () => {
  it("is an instance of Error", async () => {
    const { ApiError } = await import("../packages/cli/src/client/index");
    const err = new ApiError(404, "Not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("exposes the HTTP status code", async () => {
    const { ApiError } = await import("../packages/cli/src/client/index");
    const err = new ApiError(403, "Forbidden");
    expect(err.status).toBe(403);
  });

  it("exposes the error message", async () => {
    const { ApiError } = await import("../packages/cli/src/client/index");
    const err = new ApiError(500, "Internal error");
    expect(err.message).toBe("Internal error");
  });
});
