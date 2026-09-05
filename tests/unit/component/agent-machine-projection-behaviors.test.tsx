import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "../../../src/features/agents/AgentDetailPage";
import { AgentsPage } from "../../../src/features/agents/AgentsPage";
import { type AgentFilters, useAgents } from "../../../src/features/agents/useAgents";
import { MachineDetailPage } from "../../../src/features/machines/MachineDetailPage";
import { MachinesPage } from "../../../src/features/machines/MachinesPage";

function wrapper(children: ReactNode, route = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function session() {
  return {
    session: { id: "web-session", expiresAt: "2026-09-01T13:00:00.000Z", csrfToken: "csrf-token" },
    user: { id: "human-1", tenantId: "tenant-1", name: "Human", email: "human@example.test", role: "member" },
  };
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

function AgentListQuery({ filters }: { filters: AgentFilters }) {
  const query = useAgents(filters);
  return <output>{query.isSuccess ? "loaded" : "loading"}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent projection browser queries", () => {
  const agent = {
    id: "agent-1",
    name: "First Agent",
    description: null,
    username: "first-agent",
    runtime: "codex",
    model: null,
    skills: [],
    subject: "realmroot:agent/first",
    schedulable: true,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:01.000Z",
  };

  it("[spec: agents/read-only-browser] forwards search, runtime, and schedulable filters to the Agent collection", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return json({ items: [], pagination: { pageSize: 20 } });
      }),
    );

    wrapper(<AgentListQuery filters={{ search: "backend agent", runtime: "codex", schedulable: false }} />);

    await screen.findByText("loaded");
    expect(requests).toContain("/api/agents?search=backend+agent&runtime=codex&schedulable=false");
  });

  it("[spec: agents/read-only-browser] pages Agents with cursor history and resets cursors when search changes", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url.startsWith("/api/agents")) {
          const params = new URL(url, "https://ak.test").searchParams;
          if (params.get("pageToken") === "agent-page-2") {
            return json({ items: [{ ...agent, id: "agent-2", name: "Second Agent" }], pagination: { pageSize: 20 } });
          }
          return json({ items: [agent], pagination: { pageSize: 20, nextPageToken: "agent-page-2" } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(<AgentsPage />);

    await screen.findByText("First Agent");
    expect(requests).toContain("/api/agents?pageSize=20");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("Second Agent");
    expect(requests).toContain("/api/agents?pageSize=20&pageToken=agent-page-2");
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("First Agent");

    fireEvent.change(screen.getByRole("textbox", { name: "Search Agents" }), { target: { value: "backend" } });

    await waitFor(() => expect(requests).toContain("/api/agents?search=backend&pageSize=20"));
    expect(requests).not.toContain("/api/agents?search=backend&pageSize=20&pageToken=agent-page-2");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("[spec: agents/read-only-browser] loads Agent detail tasks by the exact projected subject", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/agents/agent-1") {
          return json({
            id: "agent-1",
            name: "Backend",
            description: null,
            username: "backend",
            runtime: "codex",
            model: null,
            skills: [],
            subject: "realmroot:agent/exact-subject",
            schedulable: true,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:01.000Z",
          });
        }
        if (url === "/api/tasks?assignedTo=realmroot%3Aagent%2Fexact-subject") {
          return json({
            pagination: { pageSize: 50 },
            items: [
              {
                id: "task-1",
                seq: 1,
                status: "todo",
                title: "Exact assignment",
                description: null,
                boardId: "board-1",
                repositoryId: null,
                repositoryName: null,
                labels: [],
                createdBy: null,
                assignedTo: "realmroot:agent/exact-subject",
                assigneeName: "Backend",
                boardType: "ops",
                pullRequestUrl: null,
                input: null,
                metadata: {},
                createdFrom: null,
                scheduledAt: null,
                position: 0,
                blocked: false,
                dependsOn: [],
                durationMinutes: null,
                subtaskCount: 0,
                sessionBinding: null,
                createdAt: "2026-09-01T12:00:00.000Z",
                updatedAt: "2026-09-01T12:00:01.000Z",
                links: {
                  self: "/api/tasks/task-1",
                  board: "/api/boards/board-1",
                  repository: null,
                  notes: "/api/tasks/task-1/notes",
                  claims: "/api/tasks/task-1/claims",
                },
              },
            ],
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(
      <Routes>
        <Route path="/agents/:agentId" element={<AgentDetailPage />} />
      </Routes>,
      "/agents/agent-1",
    );

    await screen.findByText("Exact assignment");
    expect(requests).toContain("/api/tasks?assignedTo=realmroot%3Aagent%2Fexact-subject");
    expect(requests.filter((request) => request.startsWith("/api/tasks?"))).toHaveLength(1);
  });
});

describe("Machine projection browser mutations", () => {
  const machine = {
    id: "environment-1",
    name: "Waiting for computer",
    description: null,
    status: "offline",
    currentLoad: 0,
    maxLoad: 2,
    runnerCount: 0,
    runtimes: [],
    lastHeartbeatAt: null,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:01.000Z",
  } as const;

  it("[spec: machines/environment-projection] pages Machines with cursor history", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url.startsWith("/api/machines")) {
          const params = new URL(url, "https://ak.test").searchParams;
          if (params.get("pageToken") === "machine-page-2") {
            return json({ items: [{ ...machine, id: "environment-2", name: "Second machine" }], pagination: { pageSize: 20 } });
          }
          return json({ items: [machine], pagination: { pageSize: 20, nextPageToken: "machine-page-2" } });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(<MachinesPage />);

    await screen.findByText("Waiting for computer");
    expect(requests).toContain("/api/machines?pageSize=20");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("Second machine");
    expect(requests).toContain("/api/machines?pageSize=20&pageToken=machine-page-2");
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));

    await screen.findByText("Waiting for computer");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("[spec: machines/archive-environment] resets Machine pagination after archiving from a later page", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        requests.push(`${method} ${url}`);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines/environment-2" && method === "DELETE") return new Response(null, { status: 204 });
        if (url.startsWith("/api/machines?") && method === "GET") {
          const params = new URL(url, "https://ak.test").searchParams;
          if (params.get("pageToken") === "machine-page-2") {
            return json({ items: [{ ...machine, id: "environment-2", name: "Second machine" }], pagination: { pageSize: 20 } });
          }
          return json({ items: [machine], pagination: { pageSize: 20, nextPageToken: "machine-page-2" } });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);

    await screen.findByText("Waiting for computer");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Second machine");
    fireEvent.click(screen.getByRole("button", { name: "Delete Second machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await screen.findByText("Waiting for computer");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(requests).toContain("DELETE /api/machines/environment-2");
  });

  it("[spec: machines/create-runner-setup] refreshes the paged list when detail polling observes an online Machine", async () => {
    const requests: string[] = [];
    let created = false;
    let detailObservedOnline = false;
    let createdPageOneRequests = 0;
    const createdOfflineMachine = { ...machine, id: "environment-created", name: "Waiting for created computer" };
    const createdOnlineMachine = {
      ...createdOfflineMachine,
      name: "Created computer",
      status: "online",
      runnerCount: 1,
    } as const;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        requests.push(`${method} ${url}`);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines/environment-created" && method === "GET") {
          detailObservedOnline = true;
          return json({ ...createdOnlineMachine, runners: [], authCommand: "", startCommand: "" });
        }
        if (url === "/api/machines" && method === "POST") {
          created = true;
          return json(
            {
              machine: createdOfflineMachine,
              authCommand: 'enbor-runner auth login --api-server "https://enbor.example"',
              startCommand: 'enbor-runner start --api-server "https://enbor.example" --project-id "project-1" --environment-id "environment-created"',
            },
            201,
          );
        }
        if (url.startsWith("/api/machines?") && method === "GET") {
          const params = new URL(url, "https://ak.test").searchParams;
          if (params.get("pageToken") === "machine-page-2") {
            return json({ items: [{ ...machine, id: "environment-2", name: "Second machine" }], pagination: { pageSize: 20 } });
          }
          if (!created) {
            return json({ items: [machine], pagination: { pageSize: 20, nextPageToken: "machine-page-2" } });
          }
          createdPageOneRequests += 1;
          const items = createdPageOneRequests > 1 && detailObservedOnline ? [createdOnlineMachine] : [createdOfflineMachine];
          return json({ items, pagination: { pageSize: 20, nextPageToken: "machine-page-2" } });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);

    await screen.findByText("Waiting for computer");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Second machine");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));

    await screen.findByRole("heading", { name: "Start Enbor Runner" });
    await waitFor(() => expect(screen.getByText("Created computer")).toBeInTheDocument());
    expect(screen.getByText("online")).toBeInTheDocument();
    expect(screen.getByText("1 runner · 0/2 active")).toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(createdPageOneRequests).toBeGreaterThanOrEqual(2);
  });

  it("[spec: machines/archive-environment] keeps create and archive failures visible in their dialogs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url.startsWith("/api/machines?") && method === "GET") return json({ items: [machine], pagination: { pageSize: 20 } });
        if (url === "/api/machines" && method === "POST") return json({ detail: "Enbor Environment creation unavailable" }, 503);
        if (url === "/api/machines/environment-1" && method === "DELETE") return json({ detail: "Enbor Environment archive unavailable" }, 503);
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);
    await screen.findByText("Waiting for computer");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    expect(screen.getByRole("button", { name: /Your Computer/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Cloud Sandbox/ })).toBeDisabled();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.queryByLabelText("Machine name")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enbor Environment creation unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Waiting for computer" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enbor Environment archive unavailable");
  });

  it("[spec: machines/create-runner-setup] reuses a creation key within one dialog attempt and rotates it after cancel", async () => {
    const attempts: Array<{ body: BodyInit | null | undefined; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url.startsWith("/api/machines?") && method === "GET") return json({ items: [], pagination: { pageSize: 20 } });
        if (url === "/api/machines" && method === "POST") {
          const headers = new Headers(init?.headers);
          attempts.push({ body: init?.body, key: headers.get("Idempotency-Key") });
          return json({ detail: "retryable failure" }, 503);
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);
    await screen.findByText("No Machines registered.");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));
    await waitFor(() => expect(attempts).toHaveLength(3));

    expect(attempts[0]?.key).toMatch(/.+/);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[2]?.key).toMatch(/.+/);
    expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
    expect(attempts.map(({ body }) => body)).toEqual([undefined, undefined, undefined]);
  });

  it("[spec: machines/create-runner-setup] separates installation from start and bounds the online follow-up", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const interval = vi.spyOn(window, "setInterval");
    const timeout = vi.spyOn(window, "setTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url.startsWith("/api/machines?") && method === "GET") return json({ items: [], pagination: { pageSize: 20 } });
        if (url === "/api/machines/environment-1" && method === "GET") return json({ ...machine, runners: [], authCommand: "", startCommand: "" });
        if (url === "/api/machines" && method === "POST") {
          return json(
            {
              machine,
              authCommand: 'enbor-runner auth login --api-server "https://enbor.example"',
              startCommand: 'enbor-runner start --api-server "https://enbor.example" --project-id "project-1" --environment-id "environment-1"',
            },
            201,
          );
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    const view = wrapper(<MachinesPage />);
    await screen.findByText("No Machines registered.");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    expect(screen.getByRole("button", { name: /Run Enbor Runner on this computer/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Your Computer/ }));

    await screen.findByRole("heading", { name: "Start Enbor Runner" });
    expect(screen.getByText("1. Install with Homebrew (macOS/Linux)")).toBeInTheDocument();
    expect(screen.getByText("brew install realmroot/tap/enbor-runner", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("2. Authenticate")).toBeInTheDocument();
    expect(screen.getByText('enbor-runner auth login --api-server "https://enbor.example"', { exact: true })).toBeInTheDocument();
    expect(screen.getByText("3. Start this Machine")).toBeInTheDocument();
    expect(
      screen.getByText('enbor-runner start --api-server "https://enbor.example" --project-id "project-1" --environment-id "environment-1"', {
        exact: true,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enbor Runner releases" })).toHaveAttribute("href", "https://github.com/realmroot/agency/releases");
    expect(screen.getByRole("link", { name: "Enbor Runner Docker guide" })).toHaveAttribute(
      "href",
      "https://github.com/realmroot/agency/blob/main/docs/infra/self-hosted-runner.md#docker",
    );
    await waitFor(() => {
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_000);
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    });
    view.unmount();
  });
});

describe("Machine detail Runner usage", () => {
  it("[spec: machines/runner-aggregation] [spec: machines/create-runner-setup] renders each runtime usage window within its owning Runner and hides setup commands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines/environment-1") {
          return json({
            id: "environment-1",
            name: "Runner east + 1 runner",
            description: null,
            status: "online",
            currentLoad: 2,
            maxLoad: 4,
            runnerCount: 2,
            authCommand: 'enbor-runner auth login --api-server "https://enbor.example"',
            startCommand: 'enbor-runner start --api-server "https://enbor.example" --project-id "project-1" --environment-id "environment-1"',
            runners: [
              {
                id: "runner-east",
                name: "Runner east",
                status: "active",
                currentLoad: 1,
                maxLoad: 2,
                runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
                runtimeUsage: [
                  {
                    runtime: "codex",
                    windows: [{ label: "5 hours", utilization: 18, resetsAt: "2026-09-01T17:00:00.000Z" }],
                  },
                  {
                    runtime: "claude-code",
                    windows: [{ label: "7 days", utilization: 40, resetsAt: "2026-09-08T12:00:00.000Z" }],
                  },
                ],
                lastHeartbeatAt: "2026-09-01T12:01:00.000Z",
              },
              {
                id: "runner-west",
                name: "Runner west",
                status: "active",
                currentLoad: 1,
                maxLoad: 2,
                runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
                runtimeUsage: [
                  {
                    runtime: "codex",
                    windows: [{ label: "5 hours", utilization: 76, resetsAt: "2026-09-01T18:00:00.000Z" }],
                  },
                ],
                lastHeartbeatAt: "2026-09-01T12:02:00.000Z",
              },
            ],
            runtimes: [{ runtime: "codex", models: ["gpt-5.6"], state: "ready" }],
            lastHeartbeatAt: "2026-09-01T12:02:00.000Z",
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:02:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(
      <Routes>
        <Route path="/machines/:machineId" element={<MachineDetailPage />} />
      </Routes>,
      "/machines/environment-1",
    );

    const east = await screen.findByRole("region", { name: "Runner east" });
    const west = screen.getByRole("region", { name: "Runner west" });
    expect(within(east).getByText("18% used · 82% remaining")).toBeInTheDocument();
    expect(within(west).getByText("76% used · 24% remaining")).toBeInTheDocument();
    expect(within(east).getByRole("progressbar", { name: "codex 5 hours usage" })).toHaveAttribute("aria-valuenow", "18");
    expect(within(west).getByRole("progressbar", { name: "codex 5 hours usage" })).toHaveAttribute("aria-valuenow", "76");
    expect(within(east).getByText("claude-code")).toBeInTheDocument();
    expect(within(east).getByText("Runtime inventory not reported")).toBeInTheDocument();
    expect(within(east).getByText("40% used · 60% remaining")).toBeInTheDocument();
    expect(screen.queryByText("Start AMA Runner")).not.toBeInTheDocument();
    expect(screen.queryByText('ama-runner auth login --api-server "https://ama.example"')).not.toBeInTheDocument();
    expect(
      screen.queryByText('ama-runner start --api-server "https://ama.example" --project-id "project-1" --environment-id "environment-1"'),
    ).not.toBeInTheDocument();
  });

  it("[spec: machines/create-runner-setup] keeps setup commands available on Machine detail until a Runner connects", async () => {
    const authCommand = 'enbor-runner auth login --api-server "https://enbor.example"';
    const startCommand = 'enbor-runner start --api-server "https://enbor.example" --project-id "project-1" --environment-id "environment-empty"';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines/environment-empty") {
          return json({
            id: "environment-empty",
            name: "Waiting for computer",
            description: null,
            status: "offline",
            currentLoad: 0,
            maxLoad: 0,
            runnerCount: 0,
            runners: [],
            authCommand,
            startCommand,
            runtimes: [],
            lastHeartbeatAt: null,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(
      <Routes>
        <Route path="/machines/:machineId" element={<MachineDetailPage />} />
      </Routes>,
      "/machines/environment-empty",
    );

    expect(await screen.findByText("Start Enbor Runner")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for computer" })).toBeInTheDocument();
    expect(screen.getByText(authCommand)).toBeInTheDocument();
    expect(screen.getByText(startCommand)).toBeInTheDocument();
    expect(screen.queryByText("No Runners reported yet.")).not.toBeInTheDocument();
  });

  it("[spec: machines/runner-aggregation] distinguishes an empty Runner from a runtime without usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines/environment-partial") {
          return json({
            id: "environment-partial",
            name: "Runner empty + 1 runner",
            description: null,
            status: "online",
            currentLoad: 0,
            maxLoad: 2,
            runnerCount: 2,
            runners: [
              {
                id: "runner-empty",
                name: "Runner empty",
                status: "active",
                currentLoad: 0,
                maxLoad: 1,
                runtimes: [],
                runtimeUsage: [],
                lastHeartbeatAt: null,
              },
              {
                id: "runner-no-usage",
                name: "Runner no usage",
                status: "active",
                currentLoad: 0,
                maxLoad: 1,
                runtimes: [{ runtime: "copilot", models: ["gpt-5"], state: "ready" }],
                runtimeUsage: [],
                lastHeartbeatAt: null,
              },
            ],
            runtimes: [{ runtime: "copilot", models: ["gpt-5"], state: "ready" }],
            lastHeartbeatAt: null,
            createdAt: "2026-09-01T12:00:00.000Z",
            updatedAt: "2026-09-01T12:00:00.000Z",
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    wrapper(
      <Routes>
        <Route path="/machines/:machineId" element={<MachineDetailPage />} />
      </Routes>,
      "/machines/environment-partial",
    );

    const emptyRunner = await screen.findByRole("region", { name: "Runner empty" });
    const noUsageRunner = screen.getByRole("region", { name: "Runner no usage" });
    expect(within(emptyRunner).getByText("No runtimes reported by this Runner.")).toBeInTheDocument();
    expect(within(noUsageRunner).getByText("Usage not reported.")).toBeInTheDocument();
  });
});
