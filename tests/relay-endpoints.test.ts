// @vitest-environment node

// Relay endpoint routes (Agents → 配额 tab): CRUD over relay_endpoints with
// probe-before-save validation, user-identity gating, owner scoping, and the
// live usage route. The outbound relay probe is stubbed via global fetch.

import type { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv, setupMiniflare, signUpVerifiedUser } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

const TOKEN = "sk-test-relay-token-1234";
const NEW_TOKEN = "sk-test-new-token-9999";

async function apiRequest(method: string, path: string, body?: unknown, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

function jsonResponse(data: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

const KIMI_USAGES = {
  limits: [{ detail: { limit: 100, remaining: 25, resetTime: "2027-01-01T00:00:00Z" } }],
  usage: { limit: 200, remaining: 100, resetTime: "2027-01-08T00:00:00Z" },
};

const DEEPSEEK_BALANCE = { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.34" }] };

const KIMI_BODY = { name: "Kimi relay", kind: "auto", base_url: "https://api.kimi.com/anthropic", token: TOKEN };
const DEEPSEEK_BODY = { name: "DeepSeek relay", kind: "auto", base_url: "https://api.deepseek.com/v1", token: TOKEN };

const fetchMock = vi.fn();

let userToken: string;
let userId: string;
let otherToken: string;
let machineApiKey: string;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  const { createAuth } = await import("../apps/web/server/betterAuth");
  const auth = createAuth(env);
  const session = await signUpVerifiedUser(env.DB, auth, {
    name: "Relay User",
    email: "relay-user@test.com",
    password: "test-password-123",
  });
  userToken = session.token;
  userId = session.user.id;
  const other = await signUpVerifiedUser(env.DB, auth, {
    name: "Relay Other",
    email: "relay-other@test.com",
    password: "test-password-123",
  });
  otherToken = other.token;
  machineApiKey = (await auth.api.createApiKey({ body: { userId } })).key;
}, 30000);

afterAll(async () => {
  await mf.dispose();
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  await env.DB.prepare("DELETE FROM relay_endpoints").run();
});

describe("POST /api/relays", () => {
  it("creates a relay with kind auto-detected from the URL, returning only a masked token", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));

    const res = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    expect(res.status).toBe(201);
    const raw = await res.text();
    expect(raw).not.toContain(TOKEN);
    const body = JSON.parse(raw) as { kind: string; masked_token: string; base_url: string };
    expect(body.kind).toBe("kimi");
    expect(body.masked_token).toMatch(/^sk-\.\.\..{4}$/);
    expect(body.masked_token).toBe("sk-...1234");
    expect(body.base_url).toBe("https://api.kimi.com/anthropic");

    // The probe went to the relay origin's usages endpoint with the bearer token.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kimi.com/coding/v1/usages");
    expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("rejects kind auto with an unknown host, asking for an explicit kind", async () => {
    const res = await apiRequest("POST", "/api/relays", { ...KIMI_BODY, base_url: "https://relay.example.com" }, userToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("explicitly");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 and stores nothing when the probe is unauthorized", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const res = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Relay authentication failed");

    const list = await apiRequest("GET", "/api/relays", undefined, userToken);
    expect(await list.json()).toEqual([]);
  });

  it("rejects machine (API key) identity with 403", async () => {
    const res = await apiRequest("POST", "/api/relays", KIMI_BODY, machineApiKey);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/relays", () => {
  it("rejects machine (API key) identity with 403", async () => {
    const res = await apiRequest("GET", "/api/relays", undefined, machineApiKey);
    expect(res.status).toBe(403);
  });

  it("scopes the list to the owner", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    expect(created.status).toBe(201);

    const mine = await apiRequest("GET", "/api/relays", undefined, userToken);
    expect(((await mine.json()) as unknown[]).length).toBe(1);

    const other = await apiRequest("GET", "/api/relays", undefined, otherToken);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual([]);
  });
});

describe("PUT /api/relays/:id", () => {
  it("keeps the stored token and skips the probe when the token is empty", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };
    const callsAfterCreate = fetchMock.mock.calls.length;

    const res = await apiRequest(
      "PUT",
      `/api/relays/${id}`,
      { name: "Kimi relay renamed", kind: "auto", base_url: "https://api.kimi.com/anthropic", token: "" },
      userToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; masked_token: string };
    expect(body.name).toBe("Kimi relay renamed");
    expect(body.masked_token).toBe("sk-...1234");
    // Same URL/kind and no new token → no validation probe.
    expect(fetchMock.mock.calls.length).toBe(callsAfterCreate);
  });

  it("probes and stores the new token when one is provided", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };
    fetchMock.mockClear();

    const res = await apiRequest(
      "PUT",
      `/api/relays/${id}`,
      { name: "Kimi relay", kind: "auto", base_url: "https://api.kimi.com/anthropic", token: NEW_TOKEN },
      userToken,
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(NEW_TOKEN);
    const body = JSON.parse(raw) as { masked_token: string };
    expect(body.masked_token).toBe("sk-...9999");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${NEW_TOKEN}` });
  });

  it("clears the stored model when the PUT body omits it (full-replace)", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", { ...KIMI_BODY, model: "kimi-for-coding" }, userToken);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: string; model?: string };
    expect(createdBody.model).toBe("kimi-for-coding");

    const res = await apiRequest(
      "PUT",
      `/api/relays/${createdBody.id}`,
      { name: "Kimi relay", kind: "auto", base_url: "https://api.kimi.com/anthropic", token: "" },
      userToken,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model?: string };
    expect(body.model).toBeUndefined();

    const list = await apiRequest("GET", "/api/relays", undefined, userToken);
    const [row] = (await list.json()) as { id: string; model?: string }[];
    expect(row.id).toBe(createdBody.id);
    expect(row.model).toBeUndefined();
  });

  it("rejects machine (API key) identity with 403", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };
    fetchMock.mockClear();

    const res = await apiRequest(
      "PUT",
      `/api/relays/${id}`,
      { name: "Kimi relay", kind: "auto", base_url: "https://api.kimi.com/anthropic" },
      machineApiKey,
    );
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/relays/:id", () => {
  it("deletes the relay and removes it from the list", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };

    const res = await apiRequest("DELETE", `/api/relays/${id}`, undefined, userToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const list = await apiRequest("GET", "/api/relays", undefined, userToken);
    expect(await list.json()).toEqual([]);
  });

  it("returns 404 for another owner's relay", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };

    const res = await apiRequest("DELETE", `/api/relays/${id}`, undefined, otherToken);
    expect(res.status).toBe(404);

    // Still there for the real owner.
    const list = await apiRequest("GET", "/api/relays", undefined, userToken);
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it("rejects machine (API key) identity with 403", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));
    const created = await apiRequest("POST", "/api/relays", KIMI_BODY, userToken);
    const { id } = (await created.json()) as { id: string };

    const res = await apiRequest("DELETE", `/api/relays/${id}`, undefined, machineApiKey);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/relays/:id/usage", () => {
  async function createRelay(body: unknown, probeData: unknown): Promise<string> {
    fetchMock.mockResolvedValueOnce(jsonResponse(probeData));
    const res = await apiRequest("POST", "/api/relays", body, userToken);
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("returns the probed windows for a kimi relay", async () => {
    const id = await createRelay(KIMI_BODY, KIMI_USAGES);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(KIMI_USAGES)));

    const res = await apiRequest("GET", `/api/relays/${id}/usage`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; windows: unknown[]; fetched_at: string };
    expect(body.ok).toBe(true);
    expect(body.fetched_at).toBeTruthy();
    expect(body.windows).toEqual([
      { runtime: "claude", label: "5-Hour", utilization: 75, resets_at: "2027-01-01T00:00:00.000Z" },
      { runtime: "claude", label: "7-Day", utilization: 50, resets_at: "2027-01-08T00:00:00.000Z" },
    ]);
  });

  it("includes the balance object for a deepseek relay", async () => {
    const id = await createRelay(DEEPSEEK_BODY, DEEPSEEK_BALANCE);
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(DEEPSEEK_BALANCE)));

    const res = await apiRequest("GET", `/api/relays/${id}/usage`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; balance: unknown; peak: { active: boolean } | null };
    expect(body.ok).toBe(true);
    expect(body.balance).toEqual({ available: true, total: 12.34, currency: "CNY" });
    expect(body.peak).not.toBeNull();
    expect(typeof body.peak?.active).toBe("boolean");
  });

  it("reports ok:false with error.kind unauthorized when the probe is rejected", async () => {
    const id = await createRelay(KIMI_BODY, KIMI_USAGES);
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const res = await apiRequest("GET", `/api/relays/${id}/usage`, undefined, userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error: { kind: string } };
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe("unauthorized");
  });

  it("returns 404 for another owner's relay", async () => {
    const id = await createRelay(KIMI_BODY, KIMI_USAGES);

    const res = await apiRequest("GET", `/api/relays/${id}/usage`, undefined, otherToken);
    expect(res.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the create probe
  });

  it("rejects machine (API key) identity with 403", async () => {
    const id = await createRelay(KIMI_BODY, KIMI_USAGES);
    fetchMock.mockClear();

    const res = await apiRequest("GET", `/api/relays/${id}/usage`, undefined, machineApiKey);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
