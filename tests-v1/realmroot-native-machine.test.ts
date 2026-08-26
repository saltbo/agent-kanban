// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web/server/routes";
import { createTestAgent, createTestEnv, createTestWebSession, seedUser, setupMiniflare } from "./helpers/db";

const issuer = "https://native-machine.realmroot.test";
const resource = "https://ak-machine.example.test/api";
const machineIssuerKeysPromise = generateKeyPair("ES256", { extractable: true });
const env = { ...createTestEnv(), REALMROOT_ISSUER: issuer, REALMROOT_CLI_CLIENT_ID: "ak-native-test", AK_RESOURCE: resource } as any;
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let human: Awaited<ReturnType<typeof createTestWebSession>>;
let machineId: string;
let agentId: string;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "tenant-machine", "machine@example.test");
  human = await createTestWebSession(env.DB, "tenant-machine", { subjectId: "native-human" });
  const agent = await createTestAgent(env.DB, "tenant-machine", { username: "native-machine-agent", runtime: "claude" });
  agentId = agent.id;
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mf.dispose();
});

function webRequest(method: string, path: string, body?: unknown, authority = human) {
  const headers = new Headers({ cookie: authority.cookie, "content-type": "application/json" });
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("x-csrf-token", authority.csrfToken);
  return api.fetch(
    new Request(`https://ak-machine.example.test${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  );
}

describe("Realmroot Native human machine binding", () => {
  it("bootstraps the tenant, member, machine, and binding on a Native human's first DPoP request", async () => {
    const isolated = await setupMiniflare();
    const firstLoginEnv = { ...env, DB: isolated.db };
    const firstTenant = "tenant-native-first-login";
    const registrationUrl = `${resource}/machines`;
    const firstAuthority = await machineAuthority("first-login-subject", registrationUrl, {
      profile: "human",
      tenantId: firstTenant,
    });
    try {
      expect(await isolated.db.prepare("SELECT id FROM realmroot_tenants").first()).toBeNull();
      const registration = await api.fetch(
        new Request("https://ak-machine.example.test/api/machines", {
          method: "POST",
          headers: {
            authorization: `DPoP ${firstAuthority.accessToken}`,
            dpop: firstAuthority.proof,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "First login machine",
            os: "darwin",
            version: "1.0.0",
            device_id: "native-first-login-device",
            runtimes: [],
          }),
        }),
        firstLoginEnv,
      );
      expect(registration.status, await registration.clone().text()).toBe(201);
      const registeredMachineId = ((await registration.json()) as { id: string }).id;
      await expect(isolated.db.prepare("SELECT id FROM realmroot_tenants WHERE id = ?").bind(firstTenant).first()).resolves.toEqual({
        id: firstTenant,
      });
      await expect(
        isolated.db.prepare("SELECT subject_id FROM realmroot_tenant_members WHERE tenant_id = ?").bind(firstTenant).first(),
      ).resolves.toEqual({ subject_id: "first-login-subject" });
      await expect(
        isolated.db.prepare("SELECT id FROM machines WHERE owner_id = ? AND device_id = ?").bind(firstTenant, "native-first-login-device").first(),
      ).resolves.toEqual({ id: registeredMachineId });
      await expect(
        isolated.db
          .prepare("SELECT subject_id FROM realmroot_native_machine_bindings WHERE tenant_id = ? AND machine_id = ?")
          .bind(firstTenant, registeredMachineId)
          .first(),
      ).resolves.toEqual({ subject_id: "first-login-subject" });

      const conflictingAuthority = await machineAuthority("takeover-subject", registrationUrl, {
        profile: "human",
        tenantId: firstTenant,
      });
      const conflict = await api.fetch(
        new Request("https://ak-machine.example.test/api/machines", {
          method: "POST",
          headers: {
            authorization: `DPoP ${conflictingAuthority.accessToken}`,
            dpop: conflictingAuthority.proof,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "Takeover attempt",
            os: "darwin",
            version: "2.0.0",
            device_id: "native-first-login-device",
            runtimes: [],
          }),
        }),
        firstLoginEnv,
      );
      expect(conflict.status).toBe(403);
      await expect(isolated.db.prepare("SELECT COUNT(*) AS count FROM machines WHERE owner_id = ?").bind(firstTenant).first()).resolves.toEqual({
        count: 1,
      });
      await expect(
        isolated.db.prepare("SELECT COUNT(*) AS count FROM realmroot_native_machine_bindings WHERE tenant_id = ?").bind(firstTenant).first(),
      ).resolves.toEqual({ count: 1 });
    } finally {
      await isolated.mf.dispose();
    }
  });

  it("binds the registering subject and permits heartbeat and Agent session creation", async () => {
    const registered = await webRequest("POST", "/api/machines", {
      name: "Native machine",
      os: "darwin",
      version: "1.0.0",
      device_id: "native-device-1",
      runtimes: [],
    });
    expect(registered.status).toBe(201);
    machineId = ((await registered.json()) as { id: string }).id;
    expect(
      await env.DB.prepare("SELECT machine_id FROM realmroot_native_machine_bindings WHERE tenant_id = ? AND subject_id = ?")
        .bind("tenant-machine", "native-human")
        .first(),
    ).toEqual({ machine_id: machineId });

    const heartbeat = await webRequest("POST", `/api/machines/${machineId}/heartbeat`, { version: "1.0.1", runtimes: [] });
    expect(heartbeat.status).toBe(200);

    const createdSession = await webRequest("POST", `/api/agents/${agentId}/sessions`, {
      session_id: "native-session-1",
      session_public_key: "native-session-public-key",
      machine_id: machineId,
    });
    expect(createdSession.status).toBe(201);
    expect(await env.DB.prepare("SELECT machine_id FROM agent_sessions WHERE id = 'native-session-1'").first()).toEqual({ machine_id: machineId });

    expect((await webRequest("DELETE", `/api/agents/${agentId}/sessions/native-session-1`)).status).toBe(200);
    expect((await webRequest("POST", `/api/agents/${agentId}/sessions/native-session-1/reopen`)).status).toBe(200);
  });

  it("rejects an unbound subject and a subject from another tenant", async () => {
    const unbound = await createTestWebSession(env.DB, "tenant-machine", { subjectId: "unbound-human" });
    expect((await webRequest("POST", `/api/machines/${machineId}/heartbeat`, { version: "2" }, unbound)).status).toBe(403);
    expect(
      (
        await webRequest(
          "POST",
          "/api/machines",
          { name: "Takeover", os: "darwin", version: "2", device_id: "native-device-1", runtimes: [] },
          unbound,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await webRequest(
          "POST",
          `/api/agents/${agentId}/sessions`,
          { session_id: "unbound-session", session_public_key: "public", machine_id: machineId },
          unbound,
        )
      ).status,
    ).toBe(403);
    expect((await webRequest("DELETE", `/api/agents/${agentId}/sessions/native-session-1`, undefined, unbound)).status).toBe(403);
    expect((await webRequest("POST", `/api/agents/${agentId}/sessions/native-session-1/reopen`, undefined, unbound)).status).toBe(403);

    await seedUser(env.DB, "tenant-machine-other", "other-machine@example.test");
    const crossTenant = await createTestWebSession(env.DB, "tenant-machine-other", { subjectId: "cross-tenant-human" });
    expect((await webRequest("POST", `/api/machines/${machineId}/heartbeat`, { version: "2" }, crossTenant)).status).toBe(403);
  });

  it("allows the first Native subject to claim an unbound historical machine", async () => {
    const { upsertMachine } = await import("../apps/web/server/machineRepo");
    const historical = await upsertMachine(env.DB, "tenant-machine", {
      name: "Historical machine",
      os: "darwin",
      version: "0.9.0",
      device_id: "historical-unbound-device",
      runtimes: [],
    });

    const claimed = await webRequest("POST", "/api/machines", {
      name: "Historical machine claimed",
      os: "darwin",
      version: "1.0.0",
      device_id: "historical-unbound-device",
      runtimes: [],
    });
    expect(claimed.status).toBe(201);
    expect((await claimed.json()) as { id: string }).toMatchObject({ id: historical.id });
    expect(
      await env.DB.prepare("SELECT subject_id FROM realmroot_native_machine_bindings WHERE tenant_id = 'tenant-machine' AND machine_id = ?")
        .bind(historical.id)
        .first(),
    ).toEqual({ subject_id: "native-human" });
  });

  it("allows only one Native subject to win a concurrent claim for the same machine", async () => {
    const first = await createTestWebSession(env.DB, "tenant-machine", { subjectId: "concurrent-first" });
    const second = await createTestWebSession(env.DB, "tenant-machine", { subjectId: "concurrent-second" });
    const registration = {
      name: "Concurrent machine",
      os: "darwin",
      version: "1.0.0",
      device_id: "concurrent-device",
      runtimes: [],
    };

    const responses = await Promise.all([
      webRequest("POST", "/api/machines", registration, first),
      webRequest("POST", "/api/machines", registration, second),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 403]);

    const machine = await env.DB.prepare("SELECT id FROM machines WHERE owner_id = 'tenant-machine' AND device_id = 'concurrent-device'").first<{
      id: string;
    }>();
    expect(machine).not.toBeNull();
    const bindings = await env.DB.prepare(
      "SELECT subject_id FROM realmroot_native_machine_bindings WHERE tenant_id = 'tenant-machine' AND machine_id = ?",
    )
      .bind(machine!.id)
      .all<{ subject_id: string }>();
    expect(bindings.results).toHaveLength(1);
    expect(["concurrent-first", "concurrent-second"]).toContain(bindings.results[0].subject_id);
  });

  it("rejects an unknown machine principal before creating a machine row", async () => {
    const url = `${resource}/machines`;
    const authority = await machineAuthority("unknown-machine-authority", url);
    const response = await api.fetch(
      new Request("https://ak-machine.example.test/api/machines", {
        method: "POST",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Must not persist",
          os: "darwin",
          version: "1.0.0",
          device_id: "must-not-persist-device",
          runtimes: [],
        }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT id FROM machines WHERE owner_id = 'tenant-machine' AND device_id = 'must-not-persist-device'").first(),
    ).toBeNull();
  });

  it("maps a bound Native human token to machine context for task polling, heartbeat, and sessions", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, "tenant-machine", "Native polling", "ops");
    const legacyTask = await createTask(env.DB, "tenant-machine", {
      title: "Legacy machine task",
      board_id: board.id,
      metadata: { annotations: { "runtime.source": "legacy" } },
    });
    await createTask(env.DB, "tenant-machine", {
      title: "AMA-only task",
      board_id: board.id,
      metadata: { annotations: { "runtime.source": "ama" } },
    });

    const listAuthority = await machineAuthority("native-human", `${resource}/tasks`, {
      profile: "human",
      htm: "GET",
      scope: "ak:read",
    });
    const listed = await api.fetch(
      new Request("https://ak-machine.example.test/api/tasks", {
        headers: {
          authorization: `DPoP ${listAuthority.accessToken}`,
          dpop: listAuthority.proof,
          "x-ak-machine-id": machineId,
        },
      }),
      env,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { id: string }[]).toEqual([expect.objectContaining({ id: legacyTask.id })]);

    const heartbeatUrl = `${resource}/machines/${machineId}/heartbeat`;
    const heartbeatAuthority = await machineAuthority("native-human", heartbeatUrl, { profile: "human" });
    const heartbeat = await api.fetch(
      new Request(`https://ak-machine.example.test/api/machines/${machineId}/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${heartbeatAuthority.accessToken}`,
          dpop: heartbeatAuthority.proof,
          "x-ak-machine-id": machineId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "1.1.0", runtimes: [] }),
      }),
      env,
    );
    expect(heartbeat.status).toBe(200);

    const sessionUrl = `${resource}/agents/${agentId}/sessions`;
    const sessionAuthority = await machineAuthority("native-human", sessionUrl, { profile: "human" });
    const session = await api.fetch(
      new Request(`https://ak-machine.example.test/api/agents/${agentId}/sessions`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${sessionAuthority.accessToken}`,
          dpop: sessionAuthority.proof,
          "x-ak-machine-id": machineId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ session_id: "native-token-session", session_public_key: "public", machine_id: machineId }),
      }),
      env,
    );
    expect(session.status).toBe(201);
  });

  it("rejects a forged machine header from an unbound Native human token", async () => {
    const heartbeatUrl = `${resource}/machines/${machineId}/heartbeat`;
    const authority = await machineAuthority("unbound-native-human", heartbeatUrl, { profile: "human" });
    const response = await api.fetch(
      new Request(`https://ak-machine.example.test/api/machines/${machineId}/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "x-ak-machine-id": machineId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "forged" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
  });

  it("rejects a machine principal attempting to operate a different machine", async () => {
    const otherRegistered = await webRequest("POST", "/api/machines", {
      name: "Other native machine",
      os: "darwin",
      version: "1.0.0",
      device_id: "native-device-2",
      runtimes: [],
    });
    const otherMachineId = ((await otherRegistered.json()) as { id: string }).id;
    const path = `/api/machines/${otherMachineId}/heartbeat`;
    const authority = await machineAuthority(machineId, `${resource}/machines/${otherMachineId}/heartbeat`);

    const response = await api.fetch(
      new Request(`https://ak-machine.example.test${path}`, {
        method: "POST",
        headers: {
          authorization: `DPoP ${authority.accessToken}`,
          dpop: authority.proof,
          "content-type": "application/json",
        },
        body: JSON.stringify({ version: "2" }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { message: "Realmroot machine authority is bound to a different machine" } });

    const usagePath = `/api/agents/${agentId}/sessions/native-session-1/usage`;
    const usageAuthority = await machineAuthority(otherMachineId, `${resource}/agents/${agentId}/sessions/native-session-1/usage`, {
      htm: "PATCH",
      scope: "agent:usage",
    });
    const usage = await api.fetch(
      new Request(`https://ak-machine.example.test${usagePath}`, {
        method: "PATCH",
        headers: {
          authorization: `DPoP ${usageAuthority.accessToken}`,
          dpop: usageAuthority.proof,
          "content-type": "application/json",
        },
        body: JSON.stringify({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, cost_micro_usd: 1 }),
      }),
      env,
    );
    expect(usage.status).toBe(403);
  });
});

async function machineAuthority(
  subjectId: string,
  htu: string,
  options: { htm?: string; scope?: string; profile?: "human" | "machine"; tenantId?: string } = {},
) {
  const issuerKeys = await machineIssuerKeysPromise;
  const issuerJwk = await exportJWK(issuerKeys.publicKey);
  issuerJwk.kid = "native-machine-issuer-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          id_token_signing_alg_values_supported: ["ES256"],
        });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [issuerJwk] });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const dpopKeys = await generateKeyPair("ES256", { extractable: true });
  const dpopJwk = await exportJWK(dpopKeys.publicKey);
  const accessToken = await new SignJWT({
    scope: options.scope ?? "ak:write",
    client_id: "ak-native-test",
    ...(options.profile === "human" ? {} : { sub_profile: "machine" }),
    cnf: { jkt: await calculateJwkThumbprint(dpopJwk) },
    "urn:realmroot:params:oauth:org": options.tenantId ?? "tenant-machine",
  })
    .setProtectedHeader({ alg: "ES256", kid: issuerJwk.kid, typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(resource)
    .setSubject(subjectId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(issuerKeys.privateKey);
  const proof = await new SignJWT({
    htu,
    htm: options.htm ?? "POST",
    ath: createHash("sha256").update(accessToken).digest("base64url"),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: dpopJwk })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(dpopKeys.privateKey);
  return { accessToken, proof };
}
