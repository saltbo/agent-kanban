import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "../../../src/features/agents/AgentDetailPage";
import { type AgentFilters, useAgents } from "../../../src/features/agents/useAgents";
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
  it("[spec: agents/read-only-browser] forwards search, runtime, and schedulable filters to the Agent collection", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return json({ items: [] });
      }),
    );

    wrapper(<AgentListQuery filters={{ search: "backend agent", runtime: "codex", schedulable: false }} />);

    await screen.findByText("loaded");
    expect(requests).toContain("/api/agents?search=backend+agent&runtime=codex&schedulable=false");
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
        if (url === "/api/tasks?assigned_to=realmroot%3Aagent%2Fexact-subject") {
          return json([{ id: "task-1", board_id: "board-1", title: "Exact assignment", status: "todo" }]);
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
    expect(requests).toContain("/api/tasks?assigned_to=realmroot%3Aagent%2Fexact-subject");
    expect(requests.filter((request) => request.startsWith("/api/tasks?"))).toHaveLength(1);
  });
});

describe("Machine projection browser mutations", () => {
  const machine = {
    id: "environment-1",
    name: "Build host",
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

  it("[spec: machines/archive-environment] keeps create and archive failures visible in their dialogs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines" && method === "GET") return json({ items: [machine] });
        if (url === "/api/machines" && method === "POST") return json({ detail: "AMA Environment creation unavailable" }, 503);
        if (url === "/api/machines/environment-1" && method === "DELETE") return json({ detail: "AMA Environment archive unavailable" }, 503);
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);
    await screen.findByText("Build host");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    fireEvent.change(screen.getByLabelText("Machine name"), { target: { value: "New host" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AMA Environment creation unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Build host" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("AMA Environment archive unavailable");
  });

  it("[spec: machines/create-runner-setup] reuses the creation key for retries and rotates it for changed input", async () => {
    const attempts: Array<{ name: string; key: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = input instanceof Request ? input.method : (init?.method ?? "GET");
        if (url === "/api/auth/session") return json(session());
        if (url === "/api/boards") return json([]);
        if (url === "/api/machines" && method === "GET") return json({ items: [] });
        if (url === "/api/machines" && method === "POST") {
          const headers = new Headers(init?.headers);
          attempts.push({ name: (JSON.parse(String(init?.body)) as { name: string }).name, key: headers.get("Idempotency-Key") });
          return json({ detail: "retryable failure" }, 503);
        }
        throw new Error(`Unexpected request: ${request.method} ${url}`);
      }),
    );

    wrapper(<MachinesPage />);
    await screen.findByText("No Machines registered.");
    fireEvent.click(screen.getByRole("button", { name: "Add Machine" }));
    const input = screen.getByLabelText("Machine name");
    fireEvent.change(input, { target: { value: "Build host" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    fireEvent.change(input, { target: { value: "Different host" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));
    await waitFor(() => expect(attempts).toHaveLength(3));

    expect(attempts[0]?.key).toMatch(/.+/);
    expect(attempts[1]?.key).toBe(attempts[0]?.key);
    expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
    expect(attempts.map(({ name }) => name)).toEqual(["Build host", "Build host", "Different host"]);
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
        if (url === "/api/machines" && method === "GET") return json({ items: [] });
        if (url === "/api/machines" && method === "POST") {
          return json(
            {
              machine,
              authCommand: 'ama-runner auth login --api-server "https://ama.example"',
              startCommand: 'ama-runner start --api-server "https://ama.example" --project-id "project-1" --environment-id "environment-1"',
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
    fireEvent.change(screen.getByLabelText("Machine name"), { target: { value: "Build host" } });
    fireEvent.click(screen.getByRole("button", { name: "Create", exact: true }));

    await screen.findByRole("heading", { name: "Start AMA Runner" });
    expect(screen.getByText(/must already be installed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Realmroot Agency releases" })).toHaveAttribute("href", "https://github.com/realmroot/agency/releases");
    expect(screen.getByText("1. Authenticate")).toBeInTheDocument();
    expect(screen.getByText("2. Start this Machine")).toBeInTheDocument();
    await waitFor(() => {
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 2_000);
      expect(timeout).toHaveBeenCalledWith(expect.any(Function), 30_000);
    });
    view.unmount();
  });
});
