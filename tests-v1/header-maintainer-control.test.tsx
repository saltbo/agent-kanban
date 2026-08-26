import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Header } from "../apps/web/src/components/Header";

const useSession = vi.fn();
const useBoards = vi.fn();
const useBoardMaintainers = vi.fn();
const agentsList = vi.fn();

vi.mock("../apps/web/src/lib/auth-client", () => ({
  clearAuthToken: vi.fn(),
  signOut: vi.fn(),
  useSession: (...args: unknown[]) => useSession(...args),
}));

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useBoards: (...args: unknown[]) => useBoards(...args),
  useBoardMaintainers: (...args: unknown[]) => useBoardMaintainers(...args),
}));

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    agents: { list: (...args: unknown[]) => agentsList(...args) },
    boards: { create: vi.fn() },
  },
}));

vi.mock("../apps/web/src/components/BoardSwitcher", () => ({
  BoardSwitcher: () => React.createElement("div", { "data-testid": "board-switcher" }),
}));

vi.mock("../apps/web/src/components/BoardMaintainerDialog", () => ({
  BoardMaintainerDialog: ({ open }: { open: boolean }) => (open ? React.createElement("div", { role: "dialog" }, "Add maintainer dialog") : null),
}));

vi.mock("../apps/web/src/components/AgentIdenticon", () => ({
  AgentIdenticon: () => React.createElement("div", { "data-testid": "agent-identicon" }),
}));

function renderHeader() {
  render(
    <MemoryRouter initialEntries={["/boards/board-1"]}>
      <Routes>
        <Route path="/boards/:boardId" element={<Header />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Header maintainer control", () => {
  beforeEach(() => {
    useSession.mockReturnValue({ data: { user: { name: "User", email: "user@example.com" } } });
    useBoards.mockReturnValue({ boards: [{ id: "board-1", name: "Demo board" }], refresh: vi.fn() });
    agentsList.mockResolvedValue([{ id: "agent-1", name: "Daily Agent", public_key: "public-key" }]);
  });

  it("shows an add maintainer button when the board has no maintainer", () => {
    useBoardMaintainers.mockReturnValue({ maintainers: [], loading: false, refresh: vi.fn() });

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Add maintainer" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Add maintainer dialog");
  });

  it("shows the maintainer agent avatar when the board has a maintainer", async () => {
    useBoardMaintainers.mockReturnValue({
      maintainers: [{ id: "maintainer-1", agent_id: "agent-1", status: "active" }],
      loading: false,
      refresh: vi.fn(),
    });

    renderHeader();

    expect(await screen.findByTestId("agent-identicon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View maintainer Daily Agent" })).toBeInTheDocument();
  });
});
