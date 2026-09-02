import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardSettingsPage } from "../../../src/features/boards/BoardSettingsPage";

const writeText = vi.fn();
const useBoard = vi.fn();

vi.mock("@/features/boards/hooks/useBoard", () => ({
  useBoard: (...args: unknown[]) => useBoard(...args),
  useUpdateBoard: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDeleteBoard: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock("@/features/boards/components/Header", () => ({ Header: () => null }));
vi.mock("@/features/boards/components/BoardSettingsNav", () => ({ BoardSettingsNav: () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("Board settings task badge", () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useBoard.mockReturnValue({
      loading: false,
      board: {
        id: "board-badge",
        name: "Badge board",
        description: null,
        visibility: "public",
        share_slug: "public-board",
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("shows only the Tasks badge and copies canonical markdown without a type query", async () => {
    render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ["/boards/board-badge/settings"] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, {
            path: "/boards/:boardId/settings",
            element: React.createElement(BoardSettingsPage),
          }),
        ),
      ),
    );

    expect(screen.getByAltText("AK tasks badge")).toHaveAttribute("src", `${window.location.origin}/api/share/public-board/badge.svg`);
    expect(screen.queryByAltText(/agents badge/i)).not.toBeInTheDocument();
    expect(screen.queryByAltText(/tokens badge/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy tasks" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `[![AK Tasks](${window.location.origin}/api/share/public-board/badge.svg)](${window.location.origin}/share/public-board)`,
      ),
    );
    expect(writeText.mock.calls[0][0]).not.toContain("?type=");
  });
});
