// @vitest-environment node

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolbox = vi.hoisted(() => ({
  calls: [] as { command: string; args: string[]; input?: string }[],
  code: 0,
  stdout: "{}",
  stderr: "",
}));

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding(): void };
      stderr: EventEmitter & { setEncoding(): void };
      stdin: { end(input?: string): void };
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
    const call: { command: string; args: string[]; input?: string } = { command, args };
    toolbox.calls.push(call);
    child.stdin = {
      end(input?: string) {
        call.input = input;
        queueMicrotask(() => {
          if (toolbox.stdout) child.stdout.emit("data", toolbox.stdout);
          if (toolbox.stderr) child.stderr.emit("data", toolbox.stderr);
          child.emit("close", toolbox.code);
        });
      },
    };
    return child;
  },
}));

const { AgentClient } = await import("../src/client/agent.js");
const { ApiClient, ApiError } = await import("../src/client/base.js");

class TestClient extends ApiClient {
  protected authorizationHeaders(_method: string, _url: string) {
    return Promise.resolve({ authorization: "DPoP access-token", dpop: "proof" });
  }
}

beforeEach(() => {
  toolbox.calls.length = 0;
  toolbox.code = 0;
  toolbox.stdout = JSON.stringify({ id: "task-1" });
  toolbox.stderr = "";
  delete process.env.AK_API_URL;
  delete process.env.AK_AGENT_ID;
  delete process.env.AK_SESSION_ID;
  delete process.env.AMA_SESSION_ID;
  delete process.env.REALMROOT_STATE_DIR;
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AgentClient Realmroot Toolbox transport", () => {
  it("is available only to a Realmroot-enrolled runtime", async () => {
    process.env.AK_API_URL = "https://ak.example.test";
    process.env.AK_AGENT_ID = "rr-agent-1";
    expect(await AgentClient.fromEnv()).toBeNull();

    process.env.REALMROOT_STATE_DIR = "/tmp/realmroot-agent-state";
    const client = await AgentClient.fromEnv();
    expect(client).toBeInstanceOf(AgentClient);
    expect(client?.getAgentId()).toBe("rr-agent-1");
    expect(client?.getSessionId()).toBe("");
  });

  it("invokes a read through the registered AK Resource Server", async () => {
    const client = new AgentClient("https://ignored.example.test", "rr-agent-1", "session-1");

    await expect(client.getTask("task-1")).resolves.toEqual({ id: "task-1" });
    expect(toolbox.calls).toEqual([
      {
        command: "realmroot",
        args: ["--json", "toolbox", "get", "agent-kanban/tasks/task-1", "--output", "json", "--header", "X-AK-Session-ID: session-1"],
        input: undefined,
      },
    ]);
  });

  it("lets the Resource OpenAPI operation drive scope and streams JSON input for writes", async () => {
    const client = new AgentClient("https://ignored.example.test", "rr-agent-1", "session-1");

    await client.claimTask("task-1");
    expect(toolbox.calls[0]).toEqual({
      command: "realmroot",
      args: ["--json", "toolbox", "post", "agent-kanban/tasks/task-1/claim", "--output", "json", "--header", "X-AK-Session-ID: session-1"],
      input: undefined,
    });

    await client.sendMessage("task-1", { sender_type: "agent", sender_id: "rr-agent-1", content: "done" });
    expect(toolbox.calls[1]).toEqual({
      command: "realmroot",
      args: [
        "--json",
        "toolbox",
        "post",
        "agent-kanban/tasks/task-1/messages",
        "--output",
        "json",
        "--content-type",
        "application/json",
        "--header",
        "X-AK-Session-ID: session-1",
      ],
      input: JSON.stringify({ sender_type: "agent", sender_id: "rr-agent-1", content: "done" }),
    });
  });

  it("maps Toolbox failures to a stable API error", async () => {
    toolbox.code = 1;
    toolbox.stderr = "controller denied scope";
    toolbox.stdout = "";
    const client = new AgentClient("https://ignored.example.test", "rr-agent-1", "session-1");

    const error = await client.claimTask("task-1").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, code: "REALMROOT_TOOLBOX_FAILED", message: "controller denied scope" });
  });

  it("rejects an invalid Agent session context before invoking Toolbox", async () => {
    const client = new AgentClient("https://ignored.example.test", "rr-agent-1", "bad session\nheader");

    await expect(client.getTask("task-1")).rejects.toThrow("AK_SESSION_ID is invalid");
    expect(toolbox.calls).toEqual([]);
  });
});

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
