// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectRelay, fetchRelayUsage, type RelayEndpoint } from "../packages/cli/src/providers/relayUsage.js";
import { setSchedulingSettings } from "../packages/cli/src/providers/schedulingState.js";
import { UsageFetchError } from "../packages/cli/src/providers/types.js";

const TOKEN = "test-relay-token-secret";
const NOW = new Date("2026-08-19T02:30:00.000Z"); // 10:30 Asia/Shanghai

function endpoint(kind: RelayEndpoint["kind"], baseUrl?: string): RelayEndpoint {
  return { kind, baseUrl: baseUrl ?? `https://api.${kind}.com`, token: TOKEN };
}

function jsonResponse(data: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // Deterministic scheduling: a single 09:00–12:00 Shanghai window.
  setSchedulingSettings({ peak_windows: [{ start: "09:00", end: "12:00" }], timezone: "Asia/Shanghai" });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  // Back to shared defaults so module state never leaks between tests.
  setSchedulingSettings(null);
});

describe("detectRelay", () => {
  it("maps known relay hosts", () => {
    expect(detectRelay("https://api.kimi.com")).toBe("kimi");
    expect(detectRelay("https://api.kimi.com/anthropic")).toBe("kimi");
    expect(detectRelay("https://api.deepseek.com/v1")).toBe("deepseek");
  });

  it("returns null for unknown hosts", () => {
    expect(detectRelay("https://example.com")).toBeNull();
    expect(detectRelay("https://api.kimi.com.evil.example")).toBeNull();
  });

  it("returns null for undefined or unparseable URLs", () => {
    expect(detectRelay(undefined)).toBeNull();
    expect(detectRelay("not a url")).toBeNull();
    expect(detectRelay("")).toBeNull();
  });
});

describe("fetchRelayUsage — kimi", () => {
  it("maps limits[0] and usage to 5-Hour and 7-Day windows", async () => {
    const fiveHourResetMs = Date.UTC(2026, 7, 19, 7, 30);
    const sevenDayResetMs = Date.UTC(2026, 7, 25, 0, 0);
    fetchMock.mockResolvedValue(
      jsonResponse({
        limits: [{ detail: { limit: 100, remaining: 25, resetTime: "2026-08-19T07:30:00Z" } }],
        usage: { limit: 200, remaining: 100, resetTime: sevenDayResetMs / 1000 }, // epoch seconds
      }),
    );

    const info = await fetchRelayUsage(endpoint("kimi"), NOW);

    expect(info.updated_at).toBe(NOW.toISOString());
    expect(info.windows).toEqual([
      { runtime: "claude", label: "5-Hour", utilization: 75, resets_at: "2026-08-19T07:30:00.000Z" },
      { runtime: "claude", label: "7-Day", utilization: 50, resets_at: new Date(sevenDayResetMs).toISOString() },
    ]);
    expect(fiveHourResetMs).toBe(Date.parse("2026-08-19T07:30:00.000Z"));
  });

  it("accepts resetTime as epoch milliseconds", async () => {
    const resetMs = Date.UTC(2026, 7, 19, 8, 0); // > 1e12 → treated as ms
    fetchMock.mockResolvedValue(jsonResponse({ limits: [{ detail: { limit: 10, remaining: 5, resetTime: resetMs } }] }));

    const info = await fetchRelayUsage(endpoint("kimi"), NOW);
    expect(info.windows[0].resets_at).toBe(new Date(resetMs).toISOString());
  });

  it("falls back to a synthetic reset when resetTime is missing or garbage", async () => {
    const fallback = new Date(NOW.getTime() + 60 * 60_000).toISOString();
    fetchMock.mockResolvedValue(
      jsonResponse({
        limits: [{ detail: { limit: 10, remaining: 5 } }],
        usage: { limit: 10, remaining: 5, resetTime: "not-a-date" },
      }),
    );

    const info = await fetchRelayUsage(endpoint("kimi"), NOW);
    expect(info.windows).toHaveLength(2);
    expect(info.windows[0].resets_at).toBe(fallback);
    expect(info.windows[1].resets_at).toBe(fallback);
  });

  it("omits windows whose limit/remaining are unusable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ limits: [{ detail: { limit: 0, remaining: 0 } }], usage: {} }));
    const info = await fetchRelayUsage(endpoint("kimi"), NOW);
    expect(info.windows).toEqual([]);
  });

  it("skips the 5-Hour window when limits[0].detail drifts shape, keeping the 7-Day window", async () => {
    const sevenDayResetMs = Date.UTC(2026, 7, 25, 0, 0);
    fetchMock.mockResolvedValue(
      jsonResponse({
        limits: [{}], // positional detail missing — shape drift, not "no window"
        usage: { limit: 200, remaining: 100, resetTime: sevenDayResetMs / 1000 },
      }),
    );

    const info = await fetchRelayUsage(endpoint("kimi"), NOW);
    expect(info.windows).toEqual([{ runtime: "claude", label: "7-Day", utilization: 50, resets_at: new Date(sevenDayResetMs).toISOString() }]);
  });

  it("sends the token as a bearer credential to the relay origin only", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await fetchRelayUsage(endpoint("kimi", "https://api.kimi.com/anthropic"), NOW);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("throws UsageFetchError with status on non-OK responses, without leaking the token", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429, headers: { "retry-after": "120" } }));

    const err = await fetchRelayUsage(endpoint("kimi"), NOW).catch((e) => e);
    expect(err).toBeInstanceOf(UsageFetchError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(120_000);
    expect(err.message).not.toContain(TOKEN);
  });

  it("throws UsageFetchError on network failure, without leaking the token", async () => {
    fetchMock.mockRejectedValue(new Error("socket hangup"));

    const err = await fetchRelayUsage(endpoint("kimi"), NOW).catch((e) => e);
    expect(err).toBeInstanceOf(UsageFetchError);
    expect(err.message).toContain("socket hangup");
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });
});

describe("fetchRelayUsage — deepseek", () => {
  it("reports a 100% Balance window when is_available is false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "5.00" }] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), NOW);
    expect(info.windows).toContainEqual({
      runtime: "claude",
      label: "Balance",
      utilization: 100,
      resets_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    });
  });

  it("reports a 100% Balance window when is_available is false with an empty balance_infos", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ is_available: false, balance_infos: [] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), NOW);
    const balance = info.windows.find((w) => w.label === "Balance");
    expect(balance?.utilization).toBe(100);
  });

  it("does NOT report a Balance window for an empty balance_infos when is_available is true", async () => {
    // An empty balance_infos array is shape drift, not exhaustion.
    const offPeak = new Date(Date.UTC(2026, 7, 19, 6, 0));
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), offPeak);
    expect(info.windows).toEqual([]);
  });

  it("does NOT report a Balance window when every total_balance is unparseable", async () => {
    // Unparseable balances must not read as a zero (exhausted) balance.
    const offPeak = new Date(Date.UTC(2026, 7, 19, 6, 0));
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "abc" }] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), offPeak);
    expect(info.windows).toEqual([]);
  });

  it("reports a 100% Balance window when total balance is zero", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "0" }] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), NOW);
    const balance = info.windows.find((w) => w.label === "Balance");
    expect(balance?.utilization).toBe(100);
  });

  it("reports no limit windows for a positive balance off-peak", async () => {
    // 14:00 CST — outside the configured 09:00–12:00 window.
    const offPeak = new Date(Date.UTC(2026, 7, 19, 6, 0));
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34" }] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), offPeak);
    expect(info.windows).toEqual([]);
  });

  it("reports a 100% Peak-Pricing window during peak, resetting at the window end", async () => {
    // NOW = 10:30 CST, inside 09:00–12:00.
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34" }] }));

    const info = await fetchRelayUsage(endpoint("deepseek"), NOW);
    expect(info.windows).toEqual([{ runtime: "claude", label: "Peak-Pricing", utilization: 100, resets_at: "2026-08-19T04:00:00.000Z" }]);
  });

  it("sums balance across currencies", async () => {
    const offPeak = new Date(Date.UTC(2026, 7, 19, 6, 0));
    fetchMock.mockResolvedValue(
      jsonResponse({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "0" },
          { currency: "USD", total_balance: "3.50" },
        ],
      }),
    );

    const info = await fetchRelayUsage(endpoint("deepseek"), offPeak);
    expect(info.windows).toEqual([]);
  });

  it("calls /user/balance on the relay origin", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ is_available: true, balance_infos: [] }));
    await fetchRelayUsage(endpoint("deepseek", "https://api.deepseek.com/v1"), NOW);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/user/balance");
  });

  it("throws UsageFetchError with status on non-OK responses, without leaking the token", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const err = await fetchRelayUsage(endpoint("deepseek"), NOW).catch((e) => e);
    expect(err).toBeInstanceOf(UsageFetchError);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(TOKEN);
  });
});
