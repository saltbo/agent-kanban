type RelayEvent = { code?: number; data?: unknown; reason?: string };

export class TestWebSocket {
  accepted = false;
  closedWith: { code?: number; reason?: string } | null = null;
  peer?: TestWebSocket;
  received: unknown[] = [];
  sendError?: Error;
  sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: RelayEvent) => void>>();

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: string, listener: (event: RelayEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: unknown): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
    this.peer?.emit("message", { data });
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    if (this.peer && !this.peer.closedWith) {
      this.peer.closedWith = { code, reason };
      this.peer.emit("close", { code, reason });
    }
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  emitClose(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.emit("close", { code, reason });
  }

  emitError(): void {
    this.emit("error", {});
  }

  private emit(type: string, event: RelayEvent): void {
    if (type === "message") this.received.push(event.data);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export class TestWebSocketPair {
  static latest: TestWebSocketPair | undefined;
  0: TestWebSocket;
  1: TestWebSocket;

  constructor() {
    this[0] = new TestWebSocket();
    this[1] = new TestWebSocket();
    this[0].peer = this[1];
    this[1].peer = this[0];
    TestWebSocketPair.latest = this;
  }
}

class WebSocketUpgradeResponse {
  readonly headers: Headers;
  readonly status: number;
  readonly webSocket: TestWebSocket | null;

  constructor(init: ResponseInit & { webSocket?: TestWebSocket }) {
    this.headers = new Headers(init.headers);
    this.status = init.status ?? 200;
    this.webSocket = init.webSocket ?? null;
  }
}

export function installCloudflareWebSocketTestGlobals(stubGlobal: (name: string, value: unknown) => unknown): void {
  const NativeResponse = globalThis.Response;
  // biome-ignore lint/complexity/useArrowFunction: Response must remain constructible with `new`.
  const CloudflareResponse = function (body?: BodyInit | null, init: (ResponseInit & { webSocket?: TestWebSocket }) | undefined = {}) {
    if (init.status === 101) return new WebSocketUpgradeResponse(init);
    return new NativeResponse(body, init);
  } as unknown as typeof Response;
  Object.setPrototypeOf(CloudflareResponse, NativeResponse);
  CloudflareResponse.prototype = NativeResponse.prototype;

  TestWebSocketPair.latest = undefined;
  stubGlobal("WebSocketPair", TestWebSocketPair);
  stubGlobal("Response", CloudflareResponse);
}
