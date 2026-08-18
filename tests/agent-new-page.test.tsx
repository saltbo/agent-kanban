import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentNewPage } from "../apps/web/src/routes/AgentNewPage";

vi.mock("../apps/web/src/components/Header", () => ({
  Header: () => React.createElement("header", { "data-testid": "header" }),
}));

vi.mock("../apps/web/src/components/AgentIdenticon", () => ({
  AgentIdenticon: () => React.createElement("div", { "data-testid": "agent-identicon" }),
}));

const fetchTemplateIndex = vi.fn();
const fetchTemplate = vi.fn();

vi.mock("@agent-kanban/shared", async (importActual) => {
  const actual = await importActual<typeof import("@agent-kanban/shared")>();
  return {
    ...actual,
    fetchTemplateIndex: (...args: unknown[]) => fetchTemplateIndex(...args),
    fetchTemplate: (...args: unknown[]) => fetchTemplate(...args),
  };
});

const createAgentMutateAsync = vi.fn();

vi.mock("../apps/web/src/hooks/useAgents", () => ({
  useAgents: () => ({ agents: [], loading: false, refresh: vi.fn() }),
  useCreateAgent: () => ({ mutateAsync: createAgentMutateAsync, isPending: false }),
}));

const FULLSTACK_TEMPLATE = {
  name: "Fullstack Developer",
  role: "fullstack-developer",
  runtime: "claude",
  model: "claude-sonnet-4-6",
  // No username field — mirrors upstream templates
};

function renderAgentNew() {
  render(
    <MemoryRouter initialEntries={["/agents/new"]}>
      <AgentNewPage />
    </MemoryRouter>,
  );
}

async function goToRecruitForm() {
  fireEvent.click(screen.getByRole("button", { name: /recruit/i }));
  const templateButton = await screen.findByRole("button", { name: /fullstack developer/i });
  fireEvent.click(templateButton);
  return screen.findByLabelText("Username");
}

describe("AgentNewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchTemplateIndex.mockResolvedValue([{ slug: "fullstack-developer", name: "Fullstack Developer" }]);
    fetchTemplate.mockResolvedValue({ ...FULLSTACK_TEMPLATE });
    createAgentMutateAsync.mockResolvedValue({});
  });

  it("pre-fills the username derived from the template name when recruiting", async () => {
    renderAgentNew();

    const usernameInput = await goToRecruitForm();

    expect(usernameInput).toHaveValue("fullstack-developer");
  });

  it("submits the derived username when the recruit button is clicked", async () => {
    renderAgentNew();

    await goToRecruitForm();
    fireEvent.click(screen.getByRole("button", { name: "Recruit" }));

    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledTimes(1));
    expect(createAgentMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Fullstack Developer",
        username: "fullstack-developer",
        role: "fullstack-developer",
        runtime: "claude",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("blocks submission and shows an error when the username is empty", async () => {
    renderAgentNew();

    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bolt" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    expect(createAgentMutateAsync).not.toHaveBeenCalled();
    expect(screen.getByText(/username is required/i)).toBeInTheDocument();
  });

  it("derives a slugified username from messy template names", async () => {
    fetchTemplateIndex.mockResolvedValue([{ slug: "senior-backend-dev", name: "Senior  Backend_Dev!!" }]);
    fetchTemplate.mockResolvedValue({
      name: "Senior  Backend_Dev!!",
      role: "senior-backend-dev",
      runtime: "claude",
    });
    renderAgentNew();

    fireEvent.click(screen.getByRole("button", { name: /recruit/i }));
    const templateButton = await screen.findByRole("button", { name: /senior backend_dev/i });
    fireEvent.click(templateButton);

    const usernameInput = await screen.findByLabelText("Username");
    expect(usernameInput).toHaveValue("senior-backend-dev");

    fireEvent.click(screen.getByRole("button", { name: "Recruit" }));
    await waitFor(() => expect(createAgentMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ username: "senior-backend-dev" })));
  });
});
