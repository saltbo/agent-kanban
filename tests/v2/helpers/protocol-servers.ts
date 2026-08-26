import { createServer, type Server } from "node:http";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type KeyLike, SignJWT } from "jose";

export type LocalServer = { origin: string; close(): Promise<void> };

export async function listen(handler: Parameters<typeof createServer>[0]): Promise<LocalServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local protocol server did not expose a TCP address");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => close(server) };
}

export async function startOidcServer() {
  const signing = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(signing.publicKey);
  Object.assign(publicJwk, { kid: "realmroot-test", use: "sig", alg: "ES256" });
  let origin = "";
  const local = await listen((request, response) => {
    if (request.url === "/api/auth/.well-known/openid-configuration") {
      return sendJson(response, {
        issuer: `${origin}/api/auth`,
        authorization_endpoint: `${origin}/api/auth/authorize`,
        token_endpoint: `${origin}/api/auth/token`,
        jwks_uri: `${origin}/api/auth/jwks`,
        id_token_signing_alg_values_supported: ["ES256"],
      });
    }
    if (request.url === "/api/auth/jwks") return sendJson(response, { keys: [publicJwk] });
    response.writeHead(404).end();
  });
  origin = local.origin;

  async function accessToken(input: {
    audience: string;
    scope: string;
    tenant?: string;
    subject?: string;
    clientId?: string;
    actor?: { issuer?: string; subject?: string };
    dpopPublicKey?: KeyLike;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      scope: input.scope,
      client_id: input.clientId ?? (input.actor ? "realmroot-cli" : "ak-cli"),
      sub_profile: input.actor ? undefined : "human",
      "urn:realmroot:params:oauth:org": input.tenant ?? "tenant-a",
      ...(input.actor
        ? {
            act: {
              ...(input.actor.issuer ? { iss: input.actor.issuer } : {}),
              ...(input.actor.subject ? { sub: input.actor.subject } : {}),
            },
          }
        : {}),
      ...(input.dpopPublicKey ? { cnf: { jkt: await calculateJwkThumbprint(await exportJWK(input.dpopPublicKey), "sha256") } } : {}),
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: "realmroot-test" })
      .setIssuer(`${origin}/api/auth`)
      .setAudience(input.audience)
      .setSubject(input.subject ?? "controller")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(signing.privateKey);
  }

  return { ...local, issuer: `${origin}/api/auth`, accessToken };
}

export async function dpopProof(input: { privateKey: KeyLike; publicKey: KeyLike; accessToken: string; method: string; url: string; jti?: string }) {
  const publicJwk = await exportJWK(input.publicKey);
  const ath = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input.accessToken))).toString("base64url");
  const target = new URL(input.url);
  target.search = "";
  target.hash = "";
  return new SignJWT({ htm: input.method.toUpperCase(), htu: target.toString(), ath })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk })
    .setIssuedAt()
    .setJti(input.jti ?? crypto.randomUUID())
    .sign(input.privateKey);
}

export async function startAmaServer(identity = { issuer: "http://realmroot.test/api/auth", subject: "agent-001", runtime: "ama" }) {
  const requests: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  const sessions = new Map<string, string>();
  const sessionsByDispatchLabel = new Map<string, string>();
  let failNextSession = false;
  let delayedSessionCreate: { started: () => void; release: Promise<void> } | undefined;
  let delayedSessionRead: { started: () => void; release: Promise<void> } | undefined;
  let origin = "";
  const local = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const headers = Object.fromEntries(Object.entries(request.headers).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
    requests.push({ method: request.method ?? "GET", path: request.url ?? "/", headers, body });
    if (request.url === "/api/v1/projects/project-a") return sendJson(response, { metadata: { uid: "project-a" } });
    if (request.method === "GET" && request.url?.startsWith("/api/v1/agents?")) {
      const query = new URL(request.url, origin).searchParams;
      const issuer = query.get("identityIssuer");
      const subject = query.get("identitySubject");
      const agents = [
        { metadata: { uid: "agent-a", projectId: "project-a" }, identity, spec: { runtime: "codex" }, status: { phase: "active", ready: true } },
        {
          metadata: { uid: "agent-other", projectId: "project-a" },
          identity: { ...identity, subject: "other-agent" },
          spec: { runtime: "codex" },
          status: { phase: "active", ready: true },
        },
      ].filter((agent) => agent.identity.issuer === issuer && agent.identity.subject === subject);
      return sendJson(response, { data: agents });
    }
    if (request.url === "/api/v1/agents/agent-a") {
      return sendJson(response, {
        metadata: { uid: "agent-a", projectId: "project-a" },
        identity,
        spec: { runtime: "codex" },
        status: { phase: "active", ready: true },
      });
    }
    if (request.url === "/api/v1/agents/agent-other") {
      return sendJson(response, {
        metadata: { uid: "agent-other", projectId: "project-a" },
        identity: { ...identity, subject: "other-agent" },
        spec: { runtime: "codex" },
        status: { phase: "active", ready: true },
      });
    }
    if (request.method === "GET" && request.url?.startsWith("/api/v1/sessions?")) {
      const selector = new URL(request.url, origin).searchParams.get("labelSelector");
      const dispatchKey = selector?.startsWith("agent-kanban-run=") ? selector.slice("agent-kanban-run=".length) : null;
      const sessionId = dispatchKey ? sessionsByDispatchLabel.get(dispatchKey) : undefined;
      return sendJson(response, {
        data: sessionId ? [{ metadata: { uid: sessionId }, status: { phase: sessions.get(sessionId) ?? "pending" } }] : [],
      });
    }
    if (request.url === "/api/v1/sessions" && request.method === "POST") {
      if (failNextSession) {
        failNextSession = false;
        return sendJson(response, { error: "transient" }, 503);
      }
      if (delayedSessionCreate) {
        const delayed = delayedSessionCreate;
        delayedSessionCreate = undefined;
        delayed.started();
        await delayed.release;
      }
      const id = "session-a";
      sessions.set(id, "running");
      const dispatchKey = (body as { metadata?: { labels?: Record<string, string> } } | undefined)?.metadata?.labels?.["agent-kanban-run"];
      if (dispatchKey) sessionsByDispatchLabel.set(dispatchKey, id);
      return sendJson(response, { metadata: { uid: id }, status: { phase: "running" }, links: { self: `${origin}/api/v1/sessions/${id}` } }, 201);
    }
    const session = request.url?.match(/^\/api\/v1\/sessions\/([^/]+)$/)?.[1];
    if (session && request.method === "GET") {
      if (delayedSessionRead) {
        const delayed = delayedSessionRead;
        delayedSessionRead = undefined;
        delayed.started();
        await delayed.release;
      }
      return sendJson(response, { metadata: { uid: session }, status: { phase: sessions.get(session) ?? "pending" } });
    }
    if (request.url === "/api/v1/sessions/session-a/messages" && request.method === "POST")
      return ["closed", "error"].includes(sessions.get("session-a") ?? "")
        ? sendJson(response, { error: "terminal" }, 404)
        : sendJson(response, { id: "message-a" }, 201);
    response.writeHead(404).end();
  });
  origin = local.origin;
  return {
    ...local,
    identity,
    requests,
    projectUri: `${origin}/api/v1/projects/project-a`,
    failOneSessionDispatch() {
      failNextSession = true;
    },
    setSessionStatus(id: string, status: string) {
      sessions.set(id, status);
    },
    delayNextSessionRead() {
      let signalStarted!: () => void;
      let signalRelease!: () => void;
      const requested = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });
      delayedSessionRead = { started: signalStarted, release };
      return { requested, release: signalRelease };
    },
    delayNextSessionCreate() {
      let signalStarted!: () => void;
      let signalRelease!: () => void;
      const requested = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        signalRelease = resolve;
      });
      delayedSessionCreate = { started: signalStarted, release };
      return { requested, release: signalRelease };
    },
  };
}

function sendJson(response: Parameters<Parameters<typeof createServer>[0]>[1], value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
