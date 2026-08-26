// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeAuth = vi.hoisted(() => ({
  headers: vi.fn(async () => ({ authorization: "DPoP native-token", dpop: "native-proof" })),
}));

vi.mock("../src/config.js", () => ({
  getCredentials: () => ({ apiUrl: "https://ak.example.test" }),
}));

vi.mock("../src/nativeAuth.js", () => ({
  realmrootRequestHeaders: nativeAuth.headers,
}));

const { MachineClient } = await import("../src/client/machine.js");

let requests: Request[];

beforeEach(() => {
  nativeAuth.headers.mockReset().mockResolvedValue({ authorization: "DPoP native-token", dpop: "native-proof" });
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json([]);
    }),
  );
});

describe("MachineClient Realmroot binding", () => {
  it("adds X-AK-Machine-ID to task polling, heartbeat, and session creation after bindMachine", async () => {
    const client = new MachineClient();
    client.bindMachine("machine-1");

    await client.listTasks();
    await client.heartbeat("machine-1", { version: "1.0.1", runtimes: [] });
    await client.createSession("agent-1", "session-1", "public", "machine-1");

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.headers.get("x-ak-machine-id"))).toEqual(["machine-1", "machine-1", "machine-1"]);
    expect(await requests[2].json()).toMatchObject({ machine_id: "machine-1" });
  });

  it("keeps an ordinary Native CLI in human context until a machine is bound", async () => {
    const client = new MachineClient();

    await client.listTasks();

    expect(requests[0].headers.get("x-ak-machine-id")).toBeNull();
  });

  it.each([
    ["Bearer", { authorization: "Bearer native-token" }],
    ["DPoP", { authorization: "DPoP native-token", dpop: "native-proof" }],
  ] as const)("uses %s Native authority for a WebSocket event stream and signs the HTTPS target", async (_tokenType, authority) => {
    nativeAuth.headers.mockResolvedValueOnce(authority);
    const client = new MachineClient();

    await expect(client.sessionSocketHeaders("wss://ak.example.test/api/ama/sessions/session-1/socket?projectId=project-1")).resolves.toEqual(
      authority,
    );
    expect(nativeAuth.headers).toHaveBeenCalledWith("GET", "https://ak.example.test/api/ama/sessions/session-1/socket?projectId=project-1");
  });

  it("rejects a malformed machine id before sending requests", () => {
    const client = new MachineClient();
    expect(() => client.bindMachine("bad machine\nheader")).toThrow("AK machine ID is invalid");
    expect(requests).toEqual([]);
  });
});
