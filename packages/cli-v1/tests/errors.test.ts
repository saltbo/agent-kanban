// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/client/index.js";
import {
  boundary,
  boundarySync,
  ClassifiedError,
  CleanupError,
  classify,
  RateLimitError,
  TerminalError,
  TransientError,
} from "../src/daemon/errors.js";

describe("classify — ApiError", () => {
  it("429 → transient", () => {
    const c = classify(new ApiError(429, "too many"), "ctx");
    expect(c).toBeInstanceOf(TransientError);
    expect(c.kind).toBe("transient");
  });

  it("500 → transient", () => {
    expect(classify(new ApiError(500, "oops"), "ctx")).toBeInstanceOf(TransientError);
  });

  it("502 / 503 / 504 → transient", () => {
    expect(classify(new ApiError(502, ""), "ctx")).toBeInstanceOf(TransientError);
    expect(classify(new ApiError(503, ""), "ctx")).toBeInstanceOf(TransientError);
    expect(classify(new ApiError(504, ""), "ctx")).toBeInstanceOf(TransientError);
  });

  it("401 / 403 → terminal", () => {
    expect(classify(new ApiError(401, ""), "ctx")).toBeInstanceOf(TerminalError);
    expect(classify(new ApiError(403, ""), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("404 → terminal", () => {
    expect(classify(new ApiError(404, ""), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("409 → terminal", () => {
    expect(classify(new ApiError(409, ""), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("arbitrary 4xx → terminal", () => {
    expect(classify(new ApiError(400, ""), "ctx")).toBeInstanceOf(TerminalError);
    expect(classify(new ApiError(418, ""), "ctx")).toBeInstanceOf(TerminalError);
  });
});

describe("classify — node system errors", () => {
  it("ECONNRESET → transient", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ECONNREFUSED → transient", () => {
    const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ETIMEDOUT → transient", () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("EBUSY → transient", () => {
    const err = Object.assign(new Error("busy"), { code: "EBUSY" });
    expect(classify(err, "ctx")).toBeInstanceOf(TransientError);
  });

  it("ENOENT → terminal", () => {
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });
});

describe("classify — passthrough and defaults", () => {
  it("passes ClassifiedError through unchanged", () => {
    const orig = new TransientError("already classified");
    expect(classify(orig, "ctx")).toBe(orig);
  });

  it("unknown error → terminal (fail fast)", () => {
    expect(classify(new Error("who knows"), "ctx")).toBeInstanceOf(TerminalError);
  });

  it("non-Error value → terminal", () => {
    expect(classify("string error", "ctx")).toBeInstanceOf(TerminalError);
  });

  it("AbortError → terminal", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classify(err, "ctx")).toBeInstanceOf(TerminalError);
  });

  it("includes context in message", () => {
    const c = classify(new ApiError(500, "boom"), "createSession");
    expect(c.message).toContain("createSession");
  });
});

describe("boundary / boundarySync", () => {
  it("boundary returns the fn result on success", async () => {
    const result = await boundary("ctx", async () => 42);
    expect(result).toBe(42);
  });

  it("boundary classifies thrown errors", async () => {
    await expect(
      boundary("ctx", async () => {
        throw new ApiError(500, "oops");
      }),
    ).rejects.toBeInstanceOf(TransientError);
  });

  it("boundarySync returns on success", () => {
    expect(boundarySync("ctx", () => 7)).toBe(7);
  });

  it("boundarySync classifies thrown errors", () => {
    expect(() =>
      boundarySync("ctx", () => {
        throw new ApiError(404, "gone");
      }),
    ).toThrow(TerminalError);
  });
});

describe("ClassifiedError subtypes", () => {
  it("RateLimitError carries resetAt + overage", () => {
    const err = new RateLimitError("rl", "2025-01-01T00:00:00Z", { status: "rejected", resetAt: "2025-01-01T02:00:00Z" });
    expect(err.resetAt).toBe("2025-01-01T00:00:00Z");
    expect(err.overage?.status).toBe("rejected");
    expect(err.kind).toBe("rate_limit");
  });

  it("CleanupError kind is cleanup", () => {
    const err = new CleanupError("worktree stuck");
    expect(err.kind).toBe("cleanup");
    expect(err).toBeInstanceOf(ClassifiedError);
  });
});
