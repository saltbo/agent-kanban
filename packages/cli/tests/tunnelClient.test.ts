// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "DPoP access-token", dpop: "proof" })),
}));
vi.mock("../src/nativeAuth.js", () => ({ realmrootRequestHeaders: auth.headers }));
vi.mock("../src/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

type Listener = (event: { data?: string; code?: number; reason?: string }) => void;
const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  private listeners: Record<string, Listener[]> = {};

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(listener);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code = 1000, reason = "") {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code, reason });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open", {});
  }

  message(value: unknown) {
    this.emit("message", { data: typeof value === "string" ? value : JSON.stringify(value) });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 1006, reason: "network" });
  }

  closeAsStale() {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", { code: 4000, reason: "superseded" });
  }

  private emit(type: string, event: Parameters<Listener>[0]) {
    for (const listener of this.listeners[type] ?? []) listener(event);
  }
}

vi.doMock("ws", () => ({ default: FakeWebSocket }));
const { TunnelClient } = await import("../src/daemon/tunnel.js");

async function begin(client: InstanceType<typeof TunnelClient>) {
  const connected = client.connect();
  await Promise.resolve();
  const socket = sockets.at(-1);
  if (!socket) throw new Error("Tunnel did not create a WebSocket");
  return { connected, socket };
}

beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Realmroot-authorized TunnelClient", () => {
  it("keeps credentials out of the URL and sends DPoP in the WebSocket handshake", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const { connected, socket } = await begin(client);

    expect(socket.url).toBe("wss://ak.example.test/api/tunnel/ws?role=daemon");
    expect(socket.url).not.toContain("token=");
    expect(socket.options?.headers).toEqual({
      authorization: "DPoP access-token",
      dpop: "proof",
      "x-ak-machine-id": "machine-1",
    });
    expect(auth.headers).toHaveBeenCalledWith("GET", "https://ak.example.test/api/tunnel/ws?role=daemon");
    socket.open();
    await connected;
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("uses ws for loopback HTTP resources", async () => {
    const client = new TunnelClient("http://127.0.0.1:8788", "machine-loopback");
    const { connected, socket } = await begin(client);
    expect(socket.url).toBe("ws://127.0.0.1:8788/api/tunnel/ws?role=daemon");
    socket.open();
    await connected;
    client.disconnect();
  });

  it("sends runtime events only after the tunnel opens", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const { connected, socket } = await begin(client);
    client.sendStatus("session-1", "working");
    expect(socket.sent).toEqual([]);
    socket.open();
    await connected;

    client.sendStatus("session-1", "working");
    client.sendHistory([{ role: "assistant", content: "done" }], "request-1", "session-1");
    expect(socket.sent.map((value) => JSON.parse(value))).toEqual([
      { type: "agent:status", sessionId: "session-1", status: "working" },
      { type: "session:history", requestId: "request-1", events: [{ role: "assistant", content: "done" }], sessionId: "session-1" },
    ]);
    client.disconnect();
  });

  it("dispatches human messages and history requests", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const human = vi.fn();
    const history = vi.fn();
    client.onHumanMessage(human);
    client.onHistoryRequest(history);
    const { connected, socket } = await begin(client);
    socket.open();
    await connected;

    socket.message({ type: "human:message", sessionId: "session-1", content: "continue" });
    socket.message({ type: "request:history", sessionId: "session-1", requestId: "request-1" });
    expect(human).toHaveBeenCalledWith("session-1", "continue");
    expect(history).toHaveBeenCalledWith("session-1", "request-1");
    client.disconnect();
  });

  it("reconnects once after a dropped open socket", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = await begin(client);
    first.socket.open();
    await first.connected;
    first.socket.drop();

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    client.disconnect();
  });

  it("does not reconnect after an explicit disconnect", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const { connected, socket } = await begin(client);
    socket.open();
    await connected;
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("forces a wedged handshake closed after ten seconds", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const { connected, socket } = await begin(client);
    const rejected = expect(connected).rejects.toThrow("Tunnel closed before open");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.closeCalls).toBe(1);
    await rejected;
    client.disconnect();
  });

  it("sends keepalives only while the current tunnel is open", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const { connected, socket } = await begin(client);
    socket.open();
    await connected;

    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.sent.map((value) => JSON.parse(value))).toContainEqual({ type: "ping" });
    const count = socket.sent.length;
    client.disconnect();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(socket.sent).toHaveLength(count);
  });

  it("backs off exponentially across consecutive failed reconnects", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = await begin(client);
    first.socket.drop();
    await expect(first.connected).rejects.toThrow("Tunnel closed before open");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    client.disconnect();
  });

  it("shares a reconnect attempt when manual connect occurs during pending scheduled authority", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = await begin(client);
    first.socket.open();
    await first.connected;

    let resolveHeaders: ((headers: Record<string, string>) => void) | undefined;
    auth.headers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHeaders = resolve;
        }),
    );
    first.socket.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);

    const manual = client.connect();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    resolveHeaders?.({ authorization: "DPoP refreshed", dpop: "refreshed-proof" });
    await Promise.resolve();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    await manual;
    client.disconnect();
  });

  it("does not create duplicate sockets for repeated connect calls", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = client.connect();
    const repeated = client.connect();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await Promise.all([first, repeated]);

    await client.connect();
    expect(sockets).toHaveLength(1);
    client.disconnect();
  });

  it("ignores a delayed close from a stale superseded socket", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = await begin(client);
    first.socket.open();
    await first.connected;
    const replacement = new FakeWebSocket("wss://ak.example.test/replacement");
    replacement.open();
    (client as unknown as { ws: FakeWebSocket }).ws = replacement;

    first.socket.closeAsStale();
    expect(client.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sockets).toHaveLength(2);
    client.disconnect();
  });

  it("surfaces Realmroot handshake header failures without creating a socket", async () => {
    auth.headers.mockRejectedValueOnce(new Error("native token refresh failed"));
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    await expect(client.connect()).rejects.toThrow("native token refresh failed");
    expect(sockets).toEqual([]);

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("preserves the backoff tier when manual connect joins a scheduled pending authority failure", async () => {
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const first = await begin(client);
    first.socket.open();
    await first.connected;

    let rejectHeaders: ((error: Error) => void) | undefined;
    auth.headers.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectHeaders = reject;
        }),
    );
    first.socket.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const manual = client.connect();
    rejectHeaders?.(new Error("scheduled authority rejected"));
    await expect(manual).rejects.toThrow("scheduled authority rejected");
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    client.disconnect();
  });

  it("aborts a pending authority lookup when disconnected and can connect again", async () => {
    let resolveHeaders: ((headers: Record<string, string>) => void) | undefined;
    auth.headers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHeaders = resolve;
        }),
    );
    const client = new TunnelClient("https://ak.example.test", "machine-1");
    const connecting = client.connect();
    await Promise.resolve();
    client.disconnect();
    resolveHeaders?.({ authorization: "DPoP late-token", dpop: "late-proof" });
    await expect(connecting).rejects.toThrow("Tunnel connect aborted");
    expect(sockets).toEqual([]);

    const retry = await begin(client);
    retry.socket.open();
    await retry.connected;
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("rejects a malformed machine context before connecting", () => {
    expect(() => new TunnelClient("https://ak.example.test", "machine id with spaces")).toThrow("AK machine ID is invalid");
  });
});
