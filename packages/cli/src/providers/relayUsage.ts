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
 * Security: the relay token is passed in from the caller and MUST never be
 * logged, embedded in detail strings, or sent anywhere but the relay itself.
 */

import { createLogger } from "../logger.js";
import { isPeakNow, nextOffPeakStart } from "./peakWindows.js";
import { getSchedulingSettings } from "./schedulingState.js";
import { parseRetryAfterMs, UsageFetchError, type UsageInfo, type UsageWindow } from "./types.js";

const logger = createLogger("relayUsage");

export type RelayKind = "kimi" | "deepseek";

const RELAY_HOSTS: Record<string, RelayKind> = {
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

async function fetchKimiUsage(endpoint: RelayEndpoint, now: Date): Promise<UsageInfo> {
  const data = (await fetchJson(`${originOf(endpoint.baseUrl)}/coding/v1/usages`, endpoint.token, "kimi usages")) as KimiUsagesResponse;
  const windows: UsageWindow[] = [];
  const fallback = syntheticReset(now);

  const fiveHour = data.limits?.[0]?.detail;
  const fiveHourUtil = utilizationOf(fiveHour?.limit, fiveHour?.remaining);
  if (fiveHour && fiveHourUtil !== null) {
    windows.push({ runtime: "claude", label: "5-Hour", utilization: fiveHourUtil, resets_at: normalizeResetTime(fiveHour.resetTime, fallback) });
  } else if (data.limits !== undefined && fiveHourUtil === null) {
    // limits is present but doesn't match the positional limits[0].detail
    // assumption — relay response shape drifted; surface it instead of
    // silently treating the 5h window as absent.
    logger.warn("kimi usages response shape deviates from expected limits[0].detail — 5-hour window not parsed");
  }

  const sevenDayUtil = utilizationOf(data.usage?.limit, data.usage?.remaining);
  if (data.usage && sevenDayUtil !== null) {
    windows.push({ runtime: "claude", label: "7-Day", utilization: sevenDayUtil, resets_at: normalizeResetTime(data.usage.resetTime, fallback) });
  }

  return { windows, updated_at: now.toISOString() };
}

// ---- DeepSeek ----

interface DeepSeekBalanceResponse {
  is_available?: boolean;
  balance_infos?: { currency?: string; total_balance?: string | number }[];
}

async function fetchDeepseekUsage(endpoint: RelayEndpoint, now: Date): Promise<UsageInfo> {
  const data = (await fetchJson(`${originOf(endpoint.baseUrl)}/user/balance`, endpoint.token, "deepseek balance")) as DeepSeekBalanceResponse;
  const windows: UsageWindow[] = [];

  const totalBalance = (data.balance_infos ?? []).reduce((sum, info) => {
    const value = Number(info.total_balance);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  const parsedCount = (data.balance_infos ?? []).filter((info) => Number.isFinite(Number(info.total_balance))).length;
  // total<=0 alone would false-positive on an empty/unparseable balance_infos
  // (shape change reads as "exhausted"); require at least one parsed entry.
  const balanceExhausted = data.is_available === false || (parsedCount > 0 && totalBalance <= 0);
  if (balanceExhausted) {
    // No natural reset for a topped-out balance — re-probe hourly.
    windows.push({ runtime: "claude", label: "Balance", utilization: 100, resets_at: syntheticReset(now) });
    logger.warn("deepseek balance exhausted or unavailable — runtime limited until re-probe");
  }

  const settings = getSchedulingSettings();
  if (isPeakNow(settings, now)) {
    windows.push({ runtime: "claude", label: "Peak-Pricing", utilization: 100, resets_at: nextOffPeakStart(settings, now).toISOString() });
  }

  return { windows, updated_at: now.toISOString() };
}

/**
 * Fetch quota windows for a known relay. Throws UsageFetchError on HTTP
 * failure (the UsageCollector applies retry/backoff); never returns null for
 * a reachable relay — an empty windows list means "no limits in effect".
 */
export async function fetchRelayUsage(endpoint: RelayEndpoint, now: Date = new Date()): Promise<UsageInfo> {
  switch (endpoint.kind) {
    case "kimi":
      return fetchKimiUsage(endpoint, now);
    case "deepseek":
      return fetchDeepseekUsage(endpoint, now);
  }
}
