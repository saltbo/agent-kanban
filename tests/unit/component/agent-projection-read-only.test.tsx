import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AgentDetail, AgentList } from "../../../src/features/agents/AgentProjectionPages";
import type { AgentProjection } from "../../../src/features/agents/useAgents";

const agent: AgentProjection = {
  id: "agent-1",
  name: "Backend",
  description: "Builds APIs",
  username: "backend",
  runtime: "codex",
  model: "gpt-5.6",
  skills: ["agent-kanban"],
  subject: "realmroot-agent-subject",
  schedulable: true,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:01.000Z",
};

describe("read-only Agent projection pages", () => {
  it("[spec: agents/read-only-browser] renders Agent list and detail without management controls", () => {
    const list = render(
      <MemoryRouter>
        <AgentList agents={[agent]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /backend/i })).toHaveAttribute("href", "/agents/agent-1");
    expect(screen.queryByRole("button", { name: /create|edit|archive/i })).not.toBeInTheDocument();
    list.unmount();

    render(
      <MemoryRouter>
        <AgentDetail agent={agent} />
      </MemoryRouter>,
    );
    expect(screen.getByText("realmroot-agent-subject")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create|edit|archive/i })).not.toBeInTheDocument();
  });
});
