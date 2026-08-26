/**
 * TunnelRelay — Single Durable Object that tunnels all communication between
 * daemon and browsers.
 *
 * Uses Hibernation API: WebSocket state is recovered from tags after wake-up.
 * Tags: ["daemon"] for daemon WS, [sessionId] for browser WS.
 */

export class TunnelRelay implements DurableObject {
  private pendingHistory = new Map<string, WebSocket>();

  constructor(
    private state: DurableObjectState,
    _env: unknown,
  ) {}

  private getDaemonWs(): WebSocket | null {
    const sockets = this.state.getWebSockets("daemon");
    if (sockets.length === 0) return null;
    if (sockets.length === 1) return sockets[0];

    // Multiple daemon sockets can linger after reconnects + hibernation.
    // `getWebSockets` order is NOT guaranteed after DO wake-up, so pick
    // the socket with the latest `connectedAt` attachment.
    let best: WebSocket | null = null;
    let bestTime = -1;
    for (const ws of sockets) {
      const att = ws.deserializeAttachment() as { connectedAt: number } | null;
      const t = att?.connectedAt ?? 0;
      if (t > bestTime) {
        bestTime = t;
        best = ws;
      }
    }
    return best;
  }

  private getBrowserSockets(sessionId?: string): WebSocket[] {
    if (sessionId) {
      return this.state.getWebSockets(sessionId);
    }
    const all = this.state.getWebSockets();
    const daemonSet = new Set(this.state.getWebSockets("daemon"));
    return all.filter((ws) => !daemonSet.has(ws));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const role = url.searchParams.get("role");
    const sessionId = url.searchParams.get("sessionId");

    if (role === "daemon") {
      return this.connectDaemon();
    }

    if (role === "browser" && sessionId) {
      return this.connectBrowser(sessionId);
    }

    return new Response("Invalid role or missing sessionId", { status: 400 });
  }

  private connectDaemon(): Response {
    const pair = new WebSocketPair();
    // Accept and stamp the new socket BEFORE closing stale ones. This
    // guarantees getDaemonWs() returns the new socket if any stale close
    // event fires synchronously, preventing a spurious daemon:disconnected.
    this.state.acceptWebSocket(pair[1], ["daemon"]);
    pair[1].serializeAttachment({ connectedAt: Date.now() });
    this.broadcastToBrowsers({ type: "daemon:connected" });

    // Close stale daemon sockets from prior connections. Safe because the
    // daemon's TunnelClient ignores close events from superseded sockets,
    // and getDaemonWs() will always prefer the new socket (highest connectedAt).
    for (const ws of this.state.getWebSockets("daemon")) {
      if (ws === pair[1]) continue;
      try {
        ws.close(4000, "superseded");
      } catch {
        /* already closed */
      }
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private connectBrowser(sessionId: string): Response {
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [sessionId]);

    const daemon = this.getDaemonWs();
    pair[1].send(JSON.stringify({ type: daemon ? "daemon:connected" : "daemon:disconnected" }));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const daemon = this.getDaemonWs();
    if (ws === daemon) {
      this.handleDaemonMessage(ws, msg);
    } else {
      this.handleBrowserMessage(ws, msg);
    }
  }

  private handleDaemonMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === "ping") {
      try {
        ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* daemon gone */
      }
      return;
    }

    // History response — prefer sessionId routing because Durable Object
    // hibernation does not preserve in-memory pendingHistory entries.
    if (type === "session:history" && typeof msg.sessionId === "string") {
      const data = JSON.stringify(msg);
      for (const browser of this.getBrowserSockets(msg.sessionId)) {
        try {
          browser.send(data);
        } catch {
          /* browser gone */
        }
      }
      if (msg.requestId) this.pendingHistory.delete(msg.requestId as string);
      return;
    }

    // Backward compatibility for older daemons that don't include sessionId.
    if (type === "session:history" && msg.requestId) {
      const browser = this.pendingHistory.get(msg.requestId as string);
      if (browser) {
        this.pendingHistory.delete(msg.requestId as string);
        try {
          browser.send(JSON.stringify(msg));
        } catch {
          /* browser gone */
        }
      }
      return;
    }

    // Agent event / status — forward to session subscribers
    if ((type === "agent:event" || type === "agent:status") && msg.sessionId) {
      const data = JSON.stringify(msg);
      for (const ws of this.getBrowserSockets(msg.sessionId as string)) {
        try {
          ws.send(data);
        } catch {
          /* browser gone */
        }
      }
      return;
    }
  }

  private handleBrowserMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const daemon = this.getDaemonWs();

    if (msg.type === "human:message" && daemon) {
      const tags = this.state.getTags(ws);
      const sessionId = tags.find((t) => t !== "daemon");
      if (sessionId) {
        daemon.send(JSON.stringify({ ...msg, sessionId }));
      }
      return;
    }

    if (msg.type === "request:history" && daemon) {
      const tags = this.state.getTags(ws);
      const sessionId = tags.find((t) => t !== "daemon");
      if (sessionId) {
        const requestId = crypto.randomUUID();
        this.pendingHistory.set(requestId, ws);
        daemon.send(JSON.stringify({ type: "request:history", sessionId, requestId }));
        // Timeout cleanup
        setTimeout(() => this.pendingHistory.delete(requestId), 10000);
      }
      return;
    }
  }

  webSocketClose(ws: WebSocket): void {
    if (ws === this.getDaemonWs()) {
      this.broadcastToBrowsers({ type: "daemon:disconnected" });
    }
  }

  webSocketError(ws: WebSocket): void {
    if (ws === this.getDaemonWs()) {
      this.broadcastToBrowsers({ type: "daemon:disconnected" });
    }
  }

  private broadcastToBrowsers(msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg);
    for (const ws of this.getBrowserSockets()) {
      try {
        ws.send(data);
      } catch {
        /* browser gone */
      }
    }
  }
}
