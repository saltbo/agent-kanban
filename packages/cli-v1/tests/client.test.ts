// @vitest-environment node

import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { AgentClient } = await import("../src/client/agent.js");
const { ApiClient, ApiError } = await import("../src/client/base.js");

class TestClient extends ApiClient {
  protected authorizationHeaders(_method: string, _url: string) {
    return Promise.resolve({ authorization: "DPoP access-token", dpop: "proof" });
  }
}

beforeEach(() => {
  delete process.env.AK_API_URL;
  delete process.env.AK_AGENT_ID;
  delete process.env.AK_SESSION_ID;
  delete process.env.AK_AGENT_KEY;
  delete process.env.AK_WORKER;
  delete process.env.AMA_SESSION_ID;
  delete process.env.REALMROOT_STATE_DIR;
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentClient internal Agent session transport", () => {
  it("is available only when a complete internal Agent session is present", async () => {
    const identity = await agentIdentity();
    process.env.AK_API_URL = "https://ak.example.test";
    process.env.AK_AGENT_ID = "agent-1";
    process.env.AK_SESSION_ID = "session-1";
    expect(await AgentClient.fromEnv()).toBeNull();

    process.env.AK_AGENT_KEY = JSON.stringify(await exportJWK(identity.privateKey));
    const client = await AgentClient.fromEnv();
    expect(client).toBeInstanceOf(AgentClient);
    expect(client?.getAgentId()).toBe("agent-1");
    expect(client?.getSessionId()).toBe("session-1");
  });

  it("signs each request with the internal Ed25519 Agent session", async () => {
    const identity = await agentIdentity();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ id: "task-1" });
      }),
    );
    const client = new AgentClient("https://ak.example.test", "agent-1", "session-1", identity.privateKey);

    await expect(client.getTask("task-1")).resolves.toEqual({ id: "task-1" });
    expect(requests[0].url).toBe("https://ak.example.test/api/tasks/task-1");
    const token = requests[0].headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", typ: "agent+jwt" });
    await expect(jwtVerify(token, identity.publicKey, { audience: "https://ak.example.test" })).resolves.toMatchObject({
      payload: { sub: "session-1", aid: "agent-1", jti: expect.any(String) },
    });
  });

  it("signs a WebSocket event stream with the internal Agent session", async () => {
    const identity = await agentIdentity();
    const client = new AgentClient("https://ak.example.test", "agent-1", "session-1", identity.privateKey);

    const headers = await client.sessionSocketHeaders("wss://ak.example.test/api/ama/sessions/ama-session/socket?projectId=project-1");
    const token = headers.authorization.replace(/^Bearer /, "");

    expect(headers).toEqual({ authorization: expect.stringMatching(/^Bearer /) });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", typ: "agent+jwt" });
    await expect(jwtVerify(token, identity.publicKey, { audience: "https://ak.example.test" })).resolves.toMatchObject({
      payload: { sub: "session-1", aid: "agent-1", jti: expect.any(String) },
    });
  });

  it("sends JSON writes over HTTP and uses a fresh replay identifier for every request", async () => {
    const identity = await agentIdentity();
    const requests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      }),
    );
    const client = new AgentClient("https://ak.example.test", "agent-1", "session-1", identity.privateKey);

    await client.claimTask("task-1");
    await client.sendMessage("task-1", { sender_type: "agent", sender_id: "agent-1", content: "done" });

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["POST", "https://ak.example.test/api/tasks/task-1/claim"],
      ["POST", "https://ak.example.test/api/tasks/task-1/messages"],
    ]);
    await expect(requests[1].json()).resolves.toEqual({ sender_type: "agent", sender_id: "agent-1", content: "done" });
    const claims = requests.map((request) => decodeJwt(request.headers.get("authorization")!.slice("Bearer ".length)));
    expect(claims[0].jti).not.toBe(claims[1].jti);
  });

  it("maps AK HTTP failures to a stable API error", async () => {
    const identity = await agentIdentity();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "AGENT_SESSION_CLOSED", message: "Agent session is closed" } }, { status: 401 })),
    );
    const client = new AgentClient("https://ak.example.test", "agent-1", "session-1", identity.privateKey);

    const error = await client.claimTask("task-1").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: "AGENT_SESSION_CLOSED", message: "Agent session is closed" });
  });

  it("fails fast when the serialized Agent private key is invalid", async () => {
    process.env.AK_API_URL = "https://ak.example.test";
    process.env.AK_AGENT_ID = "agent-1";
    process.env.AK_SESSION_ID = "session-1";
    process.env.AK_AGENT_KEY = "not-json";

    await expect(AgentClient.fromEnv()).rejects.toThrow();
  });
});

async function agentIdentity(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  return generateKeyPair("EdDSA", { extractable: true }) as Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>;
}

describe("native API client HTTP boundary", () => {
  it("sends DPoP authority with JSON requests", async () => {
    let request: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init);
        return Response.json({ id: "task-1" });
      }),
    );
    const client = new TestClient("https://ak.example.test");

    await client.createTask({ title: "Realmroot task" });
    expect(request?.url).toBe("https://ak.example.test/api/tasks");
    expect(request?.headers.get("authorization")).toBe("DPoP access-token");
    expect(request?.headers.get("dpop")).toBe("proof");
    expect(await request?.text()).toBe(JSON.stringify({ title: "Realmroot task" }));
  });

  it("includes the registered machine id when creating an Agent session", async () => {
    let request: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = new Request(input, init);
        return Response.json({ delegation_proof: "proof" }, { status: 201 });
      }),
    );
    const client = new TestClient("https://ak.example.test");

    await client.createSession("agent-1", "session-1", "public-key", "machine-1");

    expect(request?.url).toBe("https://ak.example.test/api/agents/agent-1/sessions");
    expect(await request?.json()).toEqual({
      session_id: "session-1",
      session_public_key: "public-key",
      machine_id: "machine-1",
    });
  });

  it("preserves structured HTTP error status and code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "FORBIDDEN", message: "tenant denied" } }, { status: 403 })),
    );
    const client = new TestClient("https://ak.example.test");

    const error = await client.getTask("task-1").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, code: "FORBIDDEN", message: "tenant denied" });
  });
});
