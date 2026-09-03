import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Header } from "../../../src/features/boards/components/Header";

vi.mock("@/features/boards/hooks/useBoard", () => ({
  useBoards: () => ({ boards: [], refresh: vi.fn() }),
}));

vi.mock("@/features/boards/components/BoardSwitcher", () => ({
  BoardSwitcher: () => null,
}));

vi.mock("@/lib/auth-client", () => ({
  signOut: vi.fn(),
  useSession: () => ({
    data: {
      user: { name: "Amber", email: "amber@example.com", role: "member" },
    },
  }),
}));

vi.mock("@/lib/theme", () => ({
  getTheme: () => "system",
  setTheme: vi.fn(),
}));

describe("Header resource navigation", () => {
  it("[spec: agents/primary-navigation] exposes Agents and Machines once in primary navigation and marks the current resource", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/agents/agent-1"]}>
        <Header />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", { name: "Resource navigation" });
    expect(navigation).toHaveClass("flex");
    expect(navigation.className).not.toMatch(/(?:^|:|\s)hidden(?:\s|$)/);
    expect(navigation.closest("header")).toHaveClass("flex-wrap");
    const agents = within(navigation).getByRole("link", { name: "Agents" });
    const machines = within(navigation).getByRole("link", { name: "Machines" });
    expect(agents).toHaveAttribute("href", "/agents");
    expect(agents).toHaveAttribute("aria-current", "page");
    expect(machines).toHaveAttribute("href", "/machines");
    expect(machines).not.toHaveAttribute("aria-current");

    const accountTrigger = view.container.querySelector('[data-slot="dropdown-menu-trigger"]');
    expect(accountTrigger).toBeInstanceOf(HTMLElement);
    fireEvent.click(accountTrigger!);

    const accountMenu = await screen.findByRole("menu");
    expect(within(accountMenu).queryByRole("menuitem", { name: "Agents" })).not.toBeInTheDocument();
    expect(within(accountMenu).queryByRole("menuitem", { name: "Machines" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Agents" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Machines" })).toHaveLength(1);
  });
});
