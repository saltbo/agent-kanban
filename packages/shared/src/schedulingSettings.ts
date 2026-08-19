/**
 * Scheduling settings — peak-pricing windows that gate task dispatch.
 *
 * Stored per-owner on the server (`owner_settings` table), delivered to local
 * daemons via the heartbeat response, and evaluated by relay usage collection
 * (DeepSeek peak pricing). Defaults match DeepSeek's published Beijing peak
 * hours (09:00–12:00, 14:00–18:00, half price off-peak).
 */

export interface PeakWindow {
  /** "HH:MM" 24h, window start (inclusive). */
  start: string;
  /** "HH:MM" 24h, window end (exclusive). Must be later than start. */
  end: string;
}

export interface SchedulingSettings {
  peak_windows: PeakWindow[];
  /** IANA timezone name, e.g. "Asia/Shanghai". */
  timezone: string;
}

export const DEFAULT_SCHEDULING_SETTINGS: SchedulingSettings = {
  peak_windows: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
  timezone: "Asia/Shanghai",
};

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validate a settings payload. Returns an error message, or null when valid. */
export function validateSchedulingSettings(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "settings must be an object";
  const { peak_windows, timezone } = raw as Record<string, unknown>;
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) return "timezone must be a valid IANA name";
  if (!Array.isArray(peak_windows)) return "peak_windows must be an array";

  const spans: { start: number; end: number }[] = [];
  for (const w of peak_windows) {
    if (typeof w !== "object" || w === null) return "each peak window must be an object";
    const { start, end } = w as Record<string, unknown>;
    if (typeof start !== "string" || !HH_MM.test(start)) return `invalid start time "${String(start)}" (expected HH:MM)`;
    if (typeof end !== "string" || !HH_MM.test(end)) return `invalid end time "${String(end)}" (expected HH:MM)`;
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);
    if (startMin >= endMin) return `window ${start}–${end} must start before it ends (cross-midnight windows are not supported)`;
    spans.push({ start: startMin, end: endMin });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return "peak windows must not overlap";
  }
  return null;
}

/**
 * Parse an untrusted payload into SchedulingSettings, falling back to defaults
 * for anything invalid. Used by the daemon when reading the heartbeat response
 * (fail-open: a malformed server payload must not break scheduling).
 */
export function normalizeSchedulingSettings(raw: unknown): SchedulingSettings {
  if (typeof raw !== "object" || raw === null || validateSchedulingSettings(raw) !== null) {
    return DEFAULT_SCHEDULING_SETTINGS;
  }
  const value = raw as SchedulingSettings;
  return { peak_windows: value.peak_windows.map((w) => ({ start: w.start, end: w.end })), timezone: value.timezone };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
