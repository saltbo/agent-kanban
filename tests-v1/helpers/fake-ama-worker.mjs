const requests = [];
const websocketMessages = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname === "/__requests" && request.method === "DELETE") {
      requests.length = 0;
      websocketMessages.length = 0;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__requests") return Response.json(requests);
    if (url.pathname === "/__websocket-messages") return Response.json(websocketMessages);

    record(request);
    const id = sessionId(url.pathname);
    if (!id || !allowed(request) || id === "session-foreign-e2e") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname.endsWith("/socket")) return openSocket(request);
    return Response.json({
      metadata: { uid: id, projectId: request.headers.get("x-ama-project-id"), name: id, labels: {}, annotations: {} },
      spec: { agentId: "agent-e2e", runtime: "ama", prompt: "historical task" },
      status: { phase: "idle", reason: null },
    });
  },
};

function record(request) {
  requests.push({
    method: request.method,
    pathname: new URL(request.url).pathname,
    authorization: request.headers.get("authorization"),
    projectId: request.headers.get("x-ama-project-id"),
  });
}

function sessionId(pathname) {
  const match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)(?:\/socket)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function allowed(request) {
  return request.headers.get("authorization") === "Bearer e2e-ama-access" && request.headers.get("x-ama-project-id") !== "project-foreign-e2e";
}

function openSocket(request) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return Response.json({ error: "upgrade required" }, { status: 426 });
  }
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    websocketMessages.push(message);
    if (message.type !== "backfill") return;
    const firstPage = message.cursor === undefined;
    setTimeout(() => {
      server.send(
        JSON.stringify({
          type: "backfill",
          requestId: message.requestId,
          events: [],
          hasMore: firstPage,
          nextCursor: firstPage ? 1 : null,
        }),
      );
    }, 250);
  });
  server.addEventListener("close", (event) => {
    if ([1004, 1005, 1006, 1015].includes(event.code)) server.close();
    else server.close(event.code, event.reason);
  });
  return new Response(null, { status: 101, webSocket: client });
}
