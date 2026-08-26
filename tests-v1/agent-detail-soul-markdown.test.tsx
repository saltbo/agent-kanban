import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "../apps/web/src/routes/AgentDetailPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

vi.mock("../apps/web/src/components/AgentIdenticon", () => ({
  AgentIdenticon: () => React.createElement("div", { "data-testid": "agent-identicon" }),
}));

const useAgent = vi.fn();
const useAgentSessions = vi.fn();
const useAgentTasks = vi.fn();
const useDeleteAgent = vi.fn();

vi.mock("../apps/web/src/hooks/useAgents", () => ({
  useAgent: (...args: unknown[]) => useAgent(...args),
  useAgentSessions: (...args: unknown[]) => useAgentSessions(...args),
  useAgentTasks: (...args: unknown[]) => useAgentTasks(...args),
  useDeleteAgent: (...args: unknown[]) => useDeleteAgent(...args),
}));

function renderAgentDetail() {
  render(
    <MemoryRouter initialEntries={["/agents/agent-1"]}>
      <Routes>
        <Route path="/agents/:id" element={<AgentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("AgentDetailPage", () => {
  beforeEach(() => {
    useAgent.mockReturnValue({
      loading: false,
      agent: {
        id: "agent-1",
        name: "Markdown Agent",
        username: "markdown-agent",
        email: "markdown-agent@example.com",
        status: {
          schedulable: false,
          tasks: {
            todo: 0,
            in_progress: 0,
            in_review: 0,
            done: 0,
            cancelled: 0,
          },
        },
        runtime: "hermes",
        model: "default",
        kind: "worker",
        builtin: false,
        public_key: "public-key",
        fingerprint: "00112233445566778899aabbccddeeff",
        created_at: new Date().toISOString(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cost_micro_usd: 0,
        logs: [],
        bio: "Short bio",
        soul: "## Operating rules\n\n- Use Markdown\n\n```ts\nconst ok = true\n```",
      },
    });
    useAgentSessions.mockReturnValue({ sessions: [] });
    useAgentTasks.mockReturnValue({ tasks: [] });
    useDeleteAgent.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
  });

  it("renders agent soul as markdown", () => {
    renderAgentDetail();

    expect(screen.getByRole("heading", { level: 2, name: "Operating rules" })).toBeInTheDocument();
    expect(screen.getByText("Use Markdown").closest("li")).toBeInTheDocument();
    const code = document.querySelector("pre code");
    expect(code?.textContent).toContain("const");
    expect(code?.textContent).toContain("ok");
  });
});
