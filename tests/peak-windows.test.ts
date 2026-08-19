// @vitest-environment node

import type { SchedulingSettings } from "@agent-kanban/shared";
import { describe, expect, it } from "vitest";
import { isPeakNow, minutesNow, nextOffPeakStart } from "../packages/cli/src/providers/peakWindows.js";

function settings(peak_windows: { start: string; end: string }[], timezone = "Asia/Shanghai"): SchedulingSettings {
  return { peak_windows, timezone };
}

// Asia/Shanghai is UTC+8 year-round (no DST): 09:00 CST = 01:00 UTC.
const MORNING_WINDOW = settings([{ start: "09:00", end: "12:00" }]);

describe("isPeakNow", () => {
  it("is true inside the window", () => {
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 2, 30)))).toBe(true); // 10:30 CST
  });

  it("is false outside the window", () => {
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 6, 0)))).toBe(false); // 14:00 CST
  });

  it("treats the window start as inclusive", () => {
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 1, 0)))).toBe(true); // exactly 09:00 CST
  });

  it("treats the window end as exclusive", () => {
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 4, 0)))).toBe(false); // exactly 12:00 CST
  });

  it("is false one minute before start and true one minute before end", () => {
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 0, 59)))).toBe(false); // 08:59 CST
    expect(isPeakNow(MORNING_WINDOW, new Date(Date.UTC(2026, 7, 19, 3, 59)))).toBe(true); // 11:59 CST
  });

  it("is never peak with empty windows", () => {
    expect(isPeakNow(settings([]), new Date(Date.UTC(2026, 7, 19, 2, 30)))).toBe(false);
  });

  it("matches any of several windows", () => {
    const two = settings([
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ]);
    expect(isPeakNow(two, new Date(Date.UTC(2026, 7, 19, 7, 0)))).toBe(true); // 15:00 CST
    expect(isPeakNow(two, new Date(Date.UTC(2026, 7, 19, 5, 0)))).toBe(false); // 13:00 CST
  });

  it("evaluates the window in the configured timezone, not UTC", () => {
    // 09:00-12:00 UTC window: 10:00 UTC is peak under UTC, but 18:00 in Shanghai.
    const utcWindow = settings([{ start: "09:00", end: "12:00" }], "UTC");
    const now = new Date(Date.UTC(2026, 7, 19, 10, 0));
    expect(isPeakNow(utcWindow, now)).toBe(true);
    expect(isPeakNow(MORNING_WINDOW, now)).toBe(false); // same instant, 18:00 CST — outside
  });

  it("reads just-after-midnight as hour 0 of the SAME wall-clock day (hourCycle h23)", () => {
    // Regression: hour12:false can emit "24" for midnight on some ICU
    // versions without rolling the day forward — 00:30 next day would read as
    // 24:30 same day, and a 00:00–01:00 window would never match.
    const midnightWindow = settings([{ start: "00:00", end: "01:00" }]);
    const now = new Date("2026-08-19T16:30:00Z"); // 00:30 on Aug 20 in Shanghai
    expect(isPeakNow(midnightWindow, now)).toBe(true);
  });
});

describe("minutesNow", () => {
  it("returns minutes since midnight in the settings timezone", () => {
    const now = new Date(Date.UTC(2026, 7, 19, 2, 30)); // 10:30 CST
    expect(minutesNow(MORNING_WINDOW, now)).toBe(630);
    expect(minutesNow(settings([], "UTC"), now)).toBe(150);
  });
});

describe("nextOffPeakStart", () => {
  it("returns the absolute Date at the window end in the configured timezone", () => {
    const now = new Date(Date.UTC(2026, 7, 19, 2, 30)); // 10:30 CST
    const end = nextOffPeakStart(MORNING_WINDOW, now);
    expect(end.getTime()).toBe(Date.UTC(2026, 7, 19, 4, 0)); // 12:00 CST = 04:00 UTC
    // Sanity: at the returned time the window is over.
    expect(isPeakNow(MORNING_WINDOW, end)).toBe(false);
  });

  it("resolves the active window's end when several windows exist", () => {
    const two = settings([
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ]);
    const now = new Date(Date.UTC(2026, 7, 19, 7, 0)); // 15:00 CST, in the second window
    expect(nextOffPeakStart(two, now).getTime()).toBe(Date.UTC(2026, 7, 19, 10, 0)); // 18:00 CST
  });

  it("returns `now` when not in a peak window", () => {
    const now = new Date(Date.UTC(2026, 7, 19, 6, 0)); // 14:00 CST — outside 09:00-12:00
    expect(nextOffPeakStart(MORNING_WINDOW, now).getTime()).toBe(now.getTime());
  });

  it("resolves the end of a just-after-midnight window to the correct wall-clock day", () => {
    // 00:30 on Aug 20 in Shanghai inside a 00:00–01:00 window — the end must
    // be 01:00 Aug 20 CST (= 17:00 UTC Aug 19), not 24h off.
    const midnightWindow = settings([{ start: "00:00", end: "01:00" }]);
    const now = new Date("2026-08-19T16:30:00Z");
    expect(nextOffPeakStart(midnightWindow, now).toISOString()).toBe("2026-08-19T17:00:00.000Z");
  });
});
