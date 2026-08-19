/**
 * Peak-window evaluation for relay quota scheduling.
 *
 * Pure functions over wall-clock time in the configured IANA timezone —
 * no new dependencies, just Intl. Windows are validated on write (shared
 * `validateSchedulingSettings` enforces start < end, no cross-midnight),
 * so evaluation here assumes same-day windows.
 */

import { type SchedulingSettings, toMinutes } from "@agent-kanban/shared";

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallClockIn(tz: string, date: Date): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // h23 guarantees 0–23 hours. hour12:false can emit "24" for midnight on
    // some ICU versions WITHOUT rolling the day forward — normalizing that to
    // 0 would read next-day 00:xx as same-day 00:xx, off by 24h.
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Offset (ms) of the timezone ahead of UTC at the given instant. */
function tzOffsetMs(tz: string, date: Date): number {
  const w = wallClockIn(tz, date);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  // Truncate both to whole minutes — the parts formatter drops seconds.
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** Convert a wall-clock time in `tz` to an absolute Date (two-pass for DST edge). */
function wallToDate(tz: string, w: WallClock): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const first = guess - tzOffsetMs(tz, new Date(guess));
  return new Date(guess - tzOffsetMs(tz, new Date(first)));
}

/** Minutes since midnight in the settings timezone. */
export function minutesNow(settings: SchedulingSettings, now: Date): number {
  const w = wallClockIn(settings.timezone, now);
  return w.hour * 60 + w.minute;
}

export function isPeakNow(settings: SchedulingSettings, now: Date): boolean {
  const m = minutesNow(settings, now);
  return settings.peak_windows.some((w) => m >= toMinutes(w.start) && m < toMinutes(w.end));
}

/**
 * Absolute time the current peak window ends. Returns `now` when not in a
 * peak window (callers only use this while `isPeakNow` is true).
 */
export function nextOffPeakStart(settings: SchedulingSettings, now: Date): Date {
  const m = minutesNow(settings, now);
  const active = settings.peak_windows.find((w) => m >= toMinutes(w.start) && m < toMinutes(w.end));
  if (!active) return now;
  const wall = wallClockIn(settings.timezone, now);
  const endMin = toMinutes(active.end);
  return wallToDate(settings.timezone, { ...wall, hour: Math.floor(endMin / 60), minute: endMin % 60 });
}
