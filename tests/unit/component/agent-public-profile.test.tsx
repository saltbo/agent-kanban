import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverAgentProfile, fetchAgentProfile } from "../../../src/features/agent-identity";
import { AgentList } from "../../../src/features/agents/AgentProjectionPages";
import type { AgentProjection } from "../../../src/features/agents/useAgents";
import { TaskCard } from "../../../src/features/tasks/components/TaskCard";

vi.mock("@/components/ui/avatar", () => ({
  Avatar: ({ children, ...props }: ComponentProps<"span">) => <span {...props}>{children}</span>,
  AvatarImage: (props: ComponentProps<"img">) => <img {...props} />,
  AvatarFallback: (props: ComponentProps<"span">) => <span data-slot="avatar-fallback" {...props} />,
}));

const subject = "0198f4d2-9b4a-7c31-8e22-123456789abc";
const issuer = "https://id.realmroot.test/api/auth";
const metadataUrl = "https://id.realmroot.test/.well-known/oauth-authorization-server/api/auth";
const profileTemplate = "https://id.realmroot.test/api/agents/{subject}";
const profileUrl = `https://id.realmroot.test/api/agents/${subject}?view=summary`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Agent public profile API", () => {
  it("constructs RFC 8414 discovery and summary profile URLs from AK protected-resource metadata", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url === "/.well-known/oauth-protected-resource") return Response.json({ authorization_servers: [issuer] });
        if (url === metadataUrl) return Response.json({ issuer, agent_profile_uri_template: profileTemplate });
        if (url === profileUrl) return Response.json(profile());
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    const discovery = await discoverAgentProfile();
    expect(discovery).toEqual({ issuer, template: profileTemplate });
    await expect(fetchAgentProfile(discovery, subject)).resolves.toEqual({
      subject,
      name: "Current Agent",
      username: "current-agent",
      picture: "https://cdn.realmroot.test/agents/current.png",
      runtime: "codex",
    });
    expect(requests).toEqual(["/.well-known/oauth-protected-resource", metadataUrl, profileUrl]);
  });

  it("rejects authorization-server metadata whose issuer differs from protected-resource discovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "/.well-known/oauth-protected-resource") return Response.json({ authorization_servers: [issuer] });
        if (url === metadataUrl) {
          return Response.json({ issuer: "https://other.realmroot.test/api/auth", agent_profile_uri_template: profileTemplate });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );

    await expect(discoverAgentProfile()).rejects.toThrow("Invalid authorization-server metadata");
  });

  it.each([
    ["mismatched subject", { ...profile(), subject: "0198f4d2-9b4a-7c31-8e22-abcdefabcdef" }],
    ["mismatched issuer", { ...profile(), issuer: "https://other.realmroot.test/api/auth" }],
    ["non-summary view", { ...profile(), view: "detail" }],
    ["invalid runtime", { ...profile(), runtime: 42 }],
  ])("rejects a %s in the public summary representation", async (_label, representation) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(representation)),
    );

    await expect(fetchAgentProfile({ issuer, template: profileTemplate }, subject)).rejects.toThrow("Invalid Agent profile representation");
  });
});

describe("Agent public profile display", () => {
  it("[spec: agents/public-identity-profile] shows the profile name and picture across Agent and Task surfaces and reuses one subject cache entry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "/.well-known/oauth-protected-resource") return Response.json({ authorization_servers: [issuer] });
      if (url === metadataUrl) return Response.json({ issuer, agent_profile_uri_template: profileTemplate });
      if (url === profileUrl) return Response.json(profile());
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithQuery(
      <>
        <AgentList agents={[agent()]} />
        <TaskCard task={task()} onClick={vi.fn()} />
      </>,
    );

    expect(await screen.findAllByText("Current Agent")).toHaveLength(2);
    expect(screen.getByText("@current-agent")).toBeInTheDocument();
    expect(screen.getAllByAltText("Current Agent avatar")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === profileUrl)).toHaveLength(1);
  });

  it.each(["unsupported extension", "unavailable discovery"])(
    "[spec: agents/public-identity-profile] keeps existing names, subjects, and identicons for %s",
    async (mode) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "/.well-known/oauth-protected-resource") {
          if (mode === "unavailable discovery") return new Response(null, { status: 503 });
          return Response.json({ authorization_servers: [issuer] });
        }
        if (url === metadataUrl) return Response.json({ issuer });
        throw new Error(`Profile request must not run without discovery: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { container } = renderWithQuery(
        <>
          <AgentList agents={[agent()]} />
          <TaskCard task={task({ assignee_name: null })} onClick={vi.fn()} />
        </>,
      );

      expect(screen.getByText("Projection Agent")).toBeInTheDocument();
      expect(screen.getByText(subject)).toBeInTheDocument();
      expect(container.querySelectorAll("[data-slot='avatar-fallback'] svg")).toHaveLength(2);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/agents/"))).toBe(false);
    },
  );
});

function renderWithQuery(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function profile() {
  return {
    type: "agent",
    view: "summary",
    issuer,
    subject,
    name: "Current Agent",
    username: "current-agent",
    picture: "https://cdn.realmroot.test/agents/current.png",
    runtime: "codex",
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:01.000Z",
  } as const;
}

function agent(): AgentProjection {
  return {
    id: "agent-1",
    name: "Projection Agent",
    description: null,
    username: "projection-agent",
    runtime: "codex",
    model: null,
    skills: [],
    subject,
    schedulable: true,
    createdAt: "2026-09-01T12:00:00.000Z",
    updatedAt: "2026-09-01T12:00:01.000Z",
  };
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    seq: 1,
    title: "Profile-backed Task",
    status: "todo",
    labels: [],
    assigned_to: subject,
    assignee_name: "Projection Agent",
    glow_suppressed: false,
    ...overrides,
  };
}
