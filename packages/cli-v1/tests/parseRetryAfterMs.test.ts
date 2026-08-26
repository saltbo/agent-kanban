// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseRetryAfterMs } from "../src/providers/types.js";

describe("parseRetryAfterMs — delta-seconds form", () => {
  it("returns milliseconds when header is an integer string", () => {
    expect(parseRetryAfterMs("120", 0)).toBe(120_000);
  });

  it("returns 0 ms when header is '0'", () => {
    expect(parseRetryAfterMs("0", 0)).toBe(0);
  });

  it("handles fractional seconds as finite number", () => {
    expect(parseRetryAfterMs("1.5", 0)).toBe(1500);
  });
});

describe("parseRetryAfterMs — HTTP-date form", () => {
  it("returns ms from now for a future HTTP-date", () => {
    const now = Date.parse("2026-04-11T10:00:00Z");
    const future = "2026-04-11T10:02:00Z"; // 2 min ahead
    const result = parseRetryAfterMs(future, now);
    expect(result).toBe(2 * 60 * 1000);
  });

  it("returns 0 when HTTP-date is in the past", () => {
    const now = Date.parse("2026-04-11T10:05:00Z");
    const past = "2026-04-11T10:00:00Z";
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });
});

describe("parseRetryAfterMs — missing or malformed", () => {
  it("returns undefined for null", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfterMs("")).toBeUndefined();
  });

  it("returns undefined for a non-numeric, non-date string", () => {
    expect(parseRetryAfterMs("banana")).toBeUndefined();
  });
});
