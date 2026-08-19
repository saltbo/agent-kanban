// @vitest-environment node

// Per-owner scheduling settings: ownerSettingsRepo (D1) + the
// GET/PUT /api/settings/scheduling routes + the scheduling key piggybacked on
// the machine heartbeat response.

import { DEFAULT_SCHEDULING_SETTINGS } from "@agent-kanban/shared";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, setupMiniflare, signUpVerifiedUser } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

async function apiRequest(method: string, path: string, body?: unknown, token?: string) {
  const { api } = await import("../apps/web/server/routes");
  const headers: Record<string, string> = { "Content-Type": "application/json", Host: "localhost:8788", "x-forwarded-proto": "http" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined && method !== "GET") init.body = JSON.stringify(body);
  return api.request(path, init, env);
}

const CUSTOM = { peak_windows: [{ start: "10:00", end: "11:30" }], timezone: "Europe/London" };

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
});

afterAll(async () => {
  await mf.dispose();
});

describe("ownerSettingsRepo", () => {
  it("returns defaults when no row exists", async () => {
    const { getSchedulingSettings } = await import("../apps/web/server/ownerSettingsRepo");
    expect(await getSchedulingSettings(env.DB, "owner-no-row")).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });

  it("round-trips put → get", async () => {
    const { getSchedulingSettings, putSchedulingSettings } = await import("../apps/web/server/ownerSettingsRepo");
    await putSchedulingSettings(env.DB, "owner-roundtrip", CUSTOM);
    expect(await getSchedulingSettings(env.DB, "owner-roundtrip")).toEqual(CUSTOM);
  });

  it("overwrites an existing row on put", async () => {
    const { getSchedulingSettings, putSchedulingSettings } = await import("../apps/web/server/ownerSettingsRepo");
    await putSchedulingSettings(env.DB, "owner-roundtrip", { peak_windows: [], timezone: "UTC" });
    expect(await getSchedulingSettings(env.DB, "owner-roundtrip")).toEqual({ peak_windows: [], timezone: "UTC" });
  });

  it("returns defaults for malformed stored JSON", async () => {
    await env.DB.prepare("INSERT INTO owner_settings (owner_id, scheduling, updated_at) VALUES (?, ?, ?)")
      .bind("owner-corrupt", "{not json", new Date().toISOString())
      .run();
    const { getSchedulingSettings } = await import("../apps/web/server/ownerSettingsRepo");
    expect(await getSchedulingSettings(env.DB, "owner-corrupt")).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });

  it("returns defaults for parseable but invalid stored settings", async () => {
    await env.DB.prepare("INSERT INTO owner_settings (owner_id, scheduling, updated_at) VALUES (?, ?, ?)")
      .bind("owner-invalid-shape", JSON.stringify({ peak_windows: "nope", timezone: "UTC" }), new Date().toISOString())
      .run();
    const { getSchedulingSettings } = await import("../apps/web/server/ownerSettingsRepo");
    expect(await getSchedulingSettings(env.DB, "owner-invalid-shape")).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });
});

describe("/api/settings/scheduling routes", () => {
  let userToken: string;
  let userId: string;
  let otherToken: string;
  let machineApiKey: string;

  beforeAll(async () => {
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const session = await signUpVerifiedUser(env.DB, auth, {
      name: "Settings User",
      email: "settings-user@test.com",
      password: "test-password-123",
    });
    userToken = session.token;
    userId = session.user.id;

    const other = await signUpVerifiedUser(env.DB, auth, {
      name: "Settings Other",
      email: "settings-other@test.com",
      password: "test-password-123",
    });
    otherToken = other.token;

    machineApiKey = (await auth.api.createApiKey({ body: { userId } })).key;
  });

  it("GET returns the defaults for a fresh owner", async () => {
    const res = await apiRequest("GET", "/api/settings/scheduling", undefined, userToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });

  it("PUT persists and GET reflects the change", async () => {
    const put = await apiRequest("PUT", "/api/settings/scheduling", CUSTOM, userToken);
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(CUSTOM);

    const get = await apiRequest("GET", "/api/settings/scheduling", undefined, userToken);
    expect(await get.json()).toEqual(CUSTOM);
  });

  it("PUT strips unknown keys before persisting", async () => {
    const valid = { peak_windows: [{ start: "09:00", end: "12:00" }], timezone: "Asia/Shanghai" };
    const put = await apiRequest("PUT", "/api/settings/scheduling", { ...valid, evil: "x" }, userToken);
    expect(put.status).toBe(200);

    const get = await apiRequest("GET", "/api/settings/scheduling", undefined, userToken);
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).toEqual(valid);
    expect(body).not.toHaveProperty("evil");
    expect(Object.keys(body).sort()).toEqual(["peak_windows", "timezone"]);
  });

  it("PUT rejects an invalid payload with 400", async () => {
    const res = await apiRequest("PUT", "/api/settings/scheduling", { peak_windows: [{ start: "12:00", end: "09:00" }], timezone: "UTC" }, userToken);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("must start before it ends");
  });

  it("PUT rejects an invalid timezone with 400", async () => {
    const res = await apiRequest("PUT", "/api/settings/scheduling", { peak_windows: [], timezone: "Not/AZone" }, userToken);
    expect(res.status).toBe(400);
  });

  it("settings are isolated per owner", async () => {
    const res = await apiRequest("GET", "/api/settings/scheduling", undefined, otherToken);
    expect(res.status).toBe(200);
    // Owner A stored CUSTOM above; owner B must still see defaults.
    expect(await res.json()).toEqual(DEFAULT_SCHEDULING_SETTINGS);
  });

  it("rejects machine (API key) identity with 403", async () => {
    const get = await apiRequest("GET", "/api/settings/scheduling", undefined, machineApiKey);
    expect(get.status).toBe(403);
    const put = await apiRequest("PUT", "/api/settings/scheduling", CUSTOM, machineApiKey);
    expect(put.status).toBe(403);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await apiRequest("GET", "/api/settings/scheduling");
    expect(res.status).toBe(401);
  });
});

describe("machine heartbeat scheduling piggyback", () => {
  it("includes the owner's scheduling settings in the heartbeat response", async () => {
    const { createAuth } = await import("../apps/web/server/betterAuth");
    const auth = createAuth(env);
    const session = await signUpVerifiedUser(env.DB, auth, {
      name: "Heartbeat User",
      email: "heartbeat-settings@test.com",
      password: "test-password-123",
    });
    const userId = session.user.id;
    const machineApiKey = (await auth.api.createApiKey({ body: { userId } })).key;

    const machineRes = await apiRequest(
      "POST",
      "/api/machines",
      {
        name: "heartbeat-settings-machine",
        os: "linux",
        version: "1.0.0",
        runtimes: [{ name: "claude", status: "ready", checked_at: new Date().toISOString() }],
        device_id: "heartbeat-settings-device",
      },
      machineApiKey,
    );
    expect(machineRes.status).toBe(201);
    const machineId = ((await machineRes.json()) as { id: string }).id;

    // Defaults before the owner customizes anything.
    const first = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, {}, machineApiKey);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { scheduling: unknown }).scheduling).toEqual(DEFAULT_SCHEDULING_SETTINGS);

    // Updated settings reach the daemon on its next heartbeat.
    await apiRequest("PUT", "/api/settings/scheduling", CUSTOM, session.token);
    const second = await apiRequest("POST", `/api/machines/${machineId}/heartbeat`, {}, machineApiKey);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { scheduling: unknown }).scheduling).toEqual(CUSTOM);
  });
});
