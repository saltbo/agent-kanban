import WebSocket from "ws";
import { createLogger } from "../logger.js";
import { realmrootRequestHeaders } from "../nativeAuth.js";
import type { AgentEvent } from "../providers/types.js";

const logger = createLogger("tunnel");

const KEEPALIVE_INTERVAL_MS = 25_000;

// Reconnect policy — exponential backoff with a hard cap.
//
// Why these numbers:
//   - 1s base: fast recovery from a single-packet blip
//   - 30s cap: after ~6 consecutive failures we stop piling on. A fully
//     failing server (e.g. DO quota exhausted) settles at 2 attempts/min =
//     ~2880/day, well under the free-tier budget.
//   - Sequence: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Safety net for a truly dead socket. If `new WebSocket()` neither fires
// `open` nor `close` nor `error` within this window — which we've observed
// happen after macOS sleep/wake leaves the network stack wedged — we force
// a close ourselves so the reconnect chain can advance.
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Single WebSocket tunnel to the relay worker.
 *
 * Daemon connects once on startup; every session event, history request,
 * and status transition flows through this one socket.
 *
 * Reconnect semantics: retry forever until `disconnect()` is called. A
 * single owner (`reconnectTimer`) serializes attempts so a bad server
 * response can't amplify one close event into many concurrent attempts.
 * Backoff grows exponentially to `RECONNECT_MAX_DELAY_MS` and resets the
 * moment we see a successful `open`.
 */
export class TunnelClient {
  private ws: WebSocket | null = null;
  private humanMessageHandler?: (sessionId: string, content: string) => void;
  private historyRequestHandler?: (sessionId: string, requestId: string) => void;
  private closed = false;
  private wsBaseUrl: string;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(
    apiUrl: string,
    private readonly machineId: string,
  ) {
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(machineId)) throw new Error("AK machine ID is invalid");
    this.wsBaseUrl = apiUrl.replace(/^https?/, (p) => (p === "https" ? "wss" : "ws"));
  }

  async connect(): Promise<void> {
    // Idempotent: if a socket is already active or a reconnect is already
    // pending, calling `connect()` again is a no-op. Without this guard, a
    // second `connect()` would orphan the first WebSocket and create two
    // concurrent reconnect chains sharing mutable state — re-introducing
    // the storm bug through a different path.
    if (this.ws !== null || this.reconnectTimer !== null) return;
    if (this.connectPromise) return this.connectPromise;
    this.closed = false;
    this.consecutiveFailures = 0;
    return this.beginConnectAttempt();
  }

  private beginConnectAttempt(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    const attempt = this.openSocket();
    const tracked = attempt.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  private async openSocket(): Promise<void> {
    const url = `${this.wsBaseUrl}/api/tunnel/ws?role=daemon`;
    const authorityUrl = url.replace(/^ws/, "http");
    let headers: Record<string, string>;
    try {
      headers = await realmrootRequestHeaders("GET", authorityUrl);
    } catch (error) {
      const message = `Tunnel authorization failed: ${error instanceof Error ? error.message : String(error)}`;
      this.onAttemptFailed(message);
      throw new Error(message, { cause: error });
    }
    if (this.closed) throw new Error("Tunnel connect aborted");
    headers["x-ak-machine-id"] = this.machineId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(url, { headers });
      } catch (err) {
        const message = `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`;
        settle(new Error(message));
        this.onAttemptFailed(message);
        return;
      }
      this.ws = ws;

      // Wedge guard — force progress if the socket never transitions state.
      this.connectTimeoutTimer = setTimeout(() => {
        this.connectTimeoutTimer = null;
        logger.warn(`Tunnel connect stalled after ${CONNECT_TIMEOUT_MS}ms — forcing close`);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        // `close` event will fire next tick and run the normal disconnect path.
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        this.clearConnectTimeout();
        this.consecutiveFailures = 0;
        logger.info("Tunnel connected");
        this.startKeepalive();
        settle();
      });

      ws.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });

      ws.addEventListener("close", (ev) => {
        // Ignore close events from superseded sockets. When the daemon
        // reconnects, the old socket's delayed close must not stop the
        // new connection's keepalive or trigger another reconnect cycle.
        // But if disconnect() was called (this.closed), always process
        // cleanup so the connect() promise settles.
        if (!this.closed && this.ws !== ws) return;

        this.ws = null;
        this.clearConnectTimeout();
        this.stopKeepalive();
        if (this.closed) {
          // `disconnect()` was called. If the socket was still connecting,
          // `settle` rejects any awaiter with a clean abort message; if it
          // had already opened, `settle` is a no-op. Either way, skip the
          // reconnect path — a shut-down tunnel must stay shut down.
          settle(new Error("Tunnel connect aborted"));
          return;
        }
        // Pre-open close from the server side — reject any awaiter so the
        // `connect()` caller never hangs, then fall through to reconnect.
        settle(new Error("Tunnel closed before open"));
        const detail = `code=${ev.code} reason=${ev.reason || "none"}`;
        this.onAttemptFailed(`Tunnel disconnected (${detail})`);
      });

      ws.addEventListener("error", () => {
        // `close` always follows `error` and handles cleanup + reconnect.
      });
    });
  }

  /** Called exactly once per failed/broken attempt to schedule the next retry. */
  private onAttemptFailed(reason: string): void {
    if (this.closed) return;
    this.consecutiveFailures += 1;
    const delayMs = this.nextBackoffMs();
    logger.warn(`${reason}, reconnecting in ${delayMs}ms (attempt ${this.consecutiveFailures})`);
    this.scheduleReconnect(delayMs);
  }

  private nextBackoffMs(): number {
    // `consecutiveFailures` has already been incremented by the caller.
    const exp = RECONNECT_BASE_DELAY_MS * 2 ** (this.consecutiveFailures - 1);
    return Math.min(exp, RECONNECT_MAX_DELAY_MS);
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.closed) return;
    // Single-source guarantee: drop any previously-scheduled timer so each
    // close event yields exactly one pending reconnect attempt.
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Errors are surfaced via the `close` handler's log + reschedule path,
      // so we swallow the rejection here to avoid unhandled-rejection warnings.
      this.beginConnectAttempt().catch(() => {});
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* close handler will recover */
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
    // Don't keep the Node event loop alive just for the keepalive timer.
    if (this.keepaliveTimer && typeof (this.keepaliveTimer as { unref?: () => void }).unref === "function") {
      (this.keepaliveTimer as { unref: () => void }).unref();
    }
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private handleMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    switch (msg.type) {
      case "human:message":
        this.humanMessageHandler?.(msg.sessionId as string, msg.content as string);
        break;
      case "request:history":
        this.historyRequestHandler?.(msg.sessionId as string, msg.requestId as string);
        break;
    }
  }

  sendEvent(sessionId: string, event: AgentEvent): void {
    this.send({ type: "agent:event", sessionId, event });
  }

  sendStatus(sessionId: string, status: "working" | "rate_limited" | "done"): void {
    this.send({ type: "agent:status", sessionId, status });
  }

  sendHistory(events: unknown[], requestId: string, sessionId?: string): void {
    this.send({ type: "session:history", events, requestId, sessionId });
  }

  onHumanMessage(handler: (sessionId: string, content: string) => void): void {
    this.humanMessageHandler = handler;
  }

  onHistoryRequest(handler: (sessionId: string, requestId: string) => void): void {
    this.historyRequestHandler = handler;
  }

  disconnect(): void {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearConnectTimeout();
    this.stopKeepalive();
    if (this.ws) {
      try {
        this.ws.close(1000, "daemon shutdown");
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
