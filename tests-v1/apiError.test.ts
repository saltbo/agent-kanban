// @vitest-environment node
import { describe, expect, it } from "vitest";

// ApiError constructor signature: (status, message, code?)
// 2-arg: (status, message) — code defaults to HTTP_{status}
// 3-arg: (status, message, code) — code is explicitly provided
describe("ApiError — constructor", () => {
  it("2-arg form: sets status and message, code defaults to HTTP_{status}", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err.code).toBe("HTTP_404");
  });

  it("3-arg form: explicit code overrides the default", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(403, "CLI too old", "CLI_UPGRADE_REQUIRED");
    expect(err.status).toBe(403);
    expect(err.message).toBe("CLI too old");
    expect(err.code).toBe("CLI_UPGRADE_REQUIRED");
  });

  it("is an instance of Error", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    expect(new ApiError(500, "Server error")).toBeInstanceOf(Error);
  });

  it("2-arg: code reflects status code", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(429, "Too many requests");
    expect(err.code).toBe("HTTP_429");
  });

  it("3-arg: provided code is preserved exactly", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(400, "Bad input", "VALIDATION_FAILED");
    expect(err.code).toBe("VALIDATION_FAILED");
  });

  it("3-arg: message is the second argument", async () => {
    const { ApiError } = await import("../packages/cli/src/client/base.js");
    const err = new ApiError(401, "Unauthorized", "AUTH_ERROR");
    expect(err.message).toBe("Unauthorized");
    expect(err.code).toBe("AUTH_ERROR");
  });
});
