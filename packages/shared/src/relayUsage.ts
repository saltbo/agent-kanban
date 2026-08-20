/**
 * Relay usage collection — quota windows for Claude Code custom endpoints.
 *
 * When Claude Code is pointed at a relay (ANTHROPIC_BASE_URL + auth token),
 * the OAuth usage API is unreachable, but the relay's own platform exposes
 * quota state. Supported relays:
 *
 *   - Kimi (api.kimi.com): 5-hour / 7-day usage windows via /coding/v1/usages
 *   - DeepSeek (api.deepseek.com): balance via /user/balance + peak-pricing
 *     windows (dispatch is gated during configured peak hours)
 *
 * Runs in both the CLI daemon (node) and the web server (workerd): logging
 * and scheduling settings are injected by the caller instead of imported.
 *
 * Security: the relay token is passed in from the caller and MUST never be
 * logged, embedded in detail strings, or sent anywhere but the relay itself.
 */

import { isPeakNow, nextOffPeakStart } from "./peakWindows.js";
import { DEFAULT_SCHEDULING_SETTINGS, type SchedulingSettings } from "./schedulingSettings.js";
import type { UsageInfo, UsageWindow } from "./types.js";

/**
 * Raised when the upstream usage API is reachable but returned a non-OK
 * status, or when the request itself failed. Carries the HTTP status (if any)
 * and parsed `Retry-After` so callers can schedule the next attempt precisely.
 */
export class UsageFetchError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "UsageFetchError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Parse an HTTP `Retry-After` header value. Supports both delta-seconds
 * (e.g. `"120"`) and HTTP-date (e.g. `"Fri, 11 Apr 2026 14:30:00 GMT"`).
 * Returns milliseconds from now, or `undefined` if the header is missing
 * or malformed.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const ts = Date.parse(headerValue);
  if (!Number.isNaN(ts)) return Math.max(ts - now, 0);
  return undefined;
}

export type RelayKind = "kimi" | "deepseek";

export const RELAY_HOSTS: Record<string, RelayKind> = {
  "api.kimi.com": "kimi",
  "api.deepseek.com": "deepseek",
};

/** Identify a known relay from ANTHROPIC_BASE_URL. Unknown hosts → null (no quota probing). */
export function detectRelay(baseUrl: string | undefined): RelayKind | null {
  if (!baseUrl) return null;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return null;
  }
  return RELAY_HOSTS[host] ?? null;
}

export interface RelayEndpoint {
  kind: RelayKind;
  baseUrl: string;
  /** Relay credential (ANTHROPIC_AUTH_TOKEN). Never log this value. */
  token: string;
}

/** DeepSeek balance details, exposed for the quota card (the CLI only needs windows). */
export interface RelayBalanceInfo {
  available: boolean;
  total: number;
  currency: string;
}

/** DeepSeek peak-pricing state at probe time. */
export interface RelayPeakInfo {
  active: boolean;
  /** Absolute time the active peak window ends; absent when off-peak. */
  ends_at?: string;
}

export interface RelayQuotaProbe {
  /** CLI-compatible windows (5-Hour/7-Day, Balance-when-exhausted, Peak-Pricing). */
  usage: UsageInfo;
  /** DeepSeek only — populated whenever the balance response parses. */
  balance?: RelayBalanceInfo;
  /** DeepSeek only — evaluated against the injected scheduling settings. */
  peak?: RelayPeakInfo;
}

export interface RelayProbeOptions {
  /** Peak windows for DeepSeek peak-pricing evaluation. Defaults to the shared defaults. */
  scheduling?: SchedulingSettings;
  now?: Date;
  /** Shape-drift / exhaustion warnings. Token-free messages only. */
  warn?: (message: string) => void;
}

function originOf(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** Synthetic retry horizon for quotas with no natural reset (e.g. balance). */
function syntheticReset(now: Date): string {
  return new Date(now.getTime() + 60 * 60_000).toISOString();
}

/** resetTime may be ISO text or epoch seconds/ms depending on relay version. */
function normalizeResetTime(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const ts = Date.parse(value);
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
  }
  return fallback;
}

function utilizationOf(limit: unknown, remaining: unknown): number | null {
  const lim = Number(limit);
  const rem = Number(remaining);
  if (!Number.isFinite(lim) || !Number.isFinite(rem) || lim <= 0) return null;
  return Math.min(100, Math.max(0, ((lim - rem) / lim) * 100));
}

async function fetchJson(url: string, token: string, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new UsageFetchError(`${label} request failed: ${(err as Error).message}`, { cause: err });
  }
  if (!res.ok) {
    throw new UsageFetchError(`${label} API returned ${res.status}`, {
      status: res.status,
      retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
    });
  }
  return res.json();
}

// ---- Kimi ----

interface KimiQuotaDetail {
  limit?: number;
  remaining?: number;
  resetTime?: string | number;
}

interface KimiUsagesResponse {
  limits?: { detail?: KimiQuotaDetail }[];
  usage?: KimiQuotaDetail;
}

async function probeKimiQuota(endpoint: RelayEndpoint, now: Date, warn?: (message: string) => void): Promise<RelayQuotaProbe> {
  const data = (await fetchJson(`${originOf(endpoint.baseUrl)}/coding/v1/usages`, endpoint.token, "kimi usages")) as KimiUsagesResponse;
  const windows: UsageWindow[] = [];
  const fallback = syntheticReset(now);

  const fiveHour = data.limits?.[0]?.detail;
  const fiveHourUtil = utilizationOf(fiveHour?.limit, fiveHour?.remaining);
  if (fiveHour && fiveHourUtil !== null) {
    windows.push({ runtime: "claude", label: "5-Hour", utilization: fiveHourUtil, resets_at: normalizeResetTime(fiveHour.resetTime, fallback) });
  } else if (data.limits !== undefined && data.limits.length > 0 && fiveHourUtil === null) {
    // limits is present and non-empty but doesn't match the positional
    // limits[0].detail assumption — relay response shape drifted; surface it
    // instead of silently treating the 5h window as absent. An empty limits
    // array is a legitimate "no limits" state, not drift.
    warn?.("kimi usages response shape deviates from expected limits[0].detail — 5-hour window not parsed");
  }

  const sevenDayUtil = utilizationOf(data.usage?.limit, data.usage?.remaining);
  if (data.usage && sevenDayUtil !== null) {
    windows.push({ runtime: "claude", label: "7-Day", utilization: sevenDayUtil, resets_at: normalizeResetTime(data.usage.resetTime, fallback) });
  }

  return { usage: { windows, updated_at: now.toISOString() } };
}

// ---- DeepSeek ----

interface DeepSeekBalanceResponse {
  is_available?: boolean;
  balance_infos?: { currency?: string; total_balance?: string | number }[];
}

async function probeDeepseekQuota(
  endpoint: RelayEndpoint,
  now: Date,
  settings: SchedulingSettings,
  warn?: (message: string) => void,
): Promise<RelayQuotaProbe> {
  const data = (await fetchJson(`${originOf(endpoint.baseUrl)}/user/balance`, endpoint.token, "deepseek balance")) as DeepSeekBalanceResponse;
  const windows: UsageWindow[] = [];

  const infos = data.balance_infos ?? [];
  const totalBalance = infos.reduce((sum, info) => {
    const value = Number(info.total_balance);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  const parsedCount = infos.filter((info) => Number.isFinite(Number(info.total_balance))).length;
  // total<=0 alone would false-positive on an empty/unparseable balance_infos
  // (shape change reads as "exhausted"); require at least one parsed entry.
  const balanceExhausted = data.is_available === false || (parsedCount > 0 && totalBalance <= 0);
  if (balanceExhausted) {
    // No natural reset for a topped-out balance — re-probe hourly.
    windows.push({ runtime: "claude", label: "Balance", utilization: 100, resets_at: syntheticReset(now) });
    warn?.("deepseek balance exhausted or unavailable — runtime limited until re-probe");
  }

  const peakActive = isPeakNow(settings, now);
  const peak: RelayPeakInfo = { active: peakActive };
  if (peakActive) {
    peak.ends_at = nextOffPeakStart(settings, now).toISOString();
    windows.push({ runtime: "claude", label: "Peak-Pricing", utilization: 100, resets_at: peak.ends_at });
  }

  const probe: RelayQuotaProbe = { usage: { windows, updated_at: now.toISOString() }, peak };
  if (parsedCount > 0) {
    probe.balance = { available: data.is_available !== false, total: totalBalance, currency: infos.find((i) => i.currency)?.currency ?? "CNY" };
  }
  return probe;
}

/**
 * Live quota probe for a known relay, with the rich per-kind details the
 * quota card needs. Throws UsageFetchError on HTTP failure (callers apply
 * retry/backoff or surface the error state); never returns null for a
 * reachable relay — an empty windows list means "no limits in effect".
 */
export async function probeRelayQuota(endpoint: RelayEndpoint, opts: RelayProbeOptions = {}): Promise<RelayQuotaProbe> {
  const now = opts.now ?? new Date();
  switch (endpoint.kind) {
    case "kimi":
      return probeKimiQuota(endpoint, now, opts.warn);
    case "deepseek":
      return probeDeepseekQuota(endpoint, now, opts.scheduling ?? DEFAULT_SCHEDULING_SETTINGS, opts.warn);
  }
}
