import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardMaintainerDialog } from "../apps/web/src/components/BoardMaintainerDialog";

const createMutateAsync = vi.fn();
const updateMutateAsync = vi.fn();
const agentsList = vi.fn();

vi.mock("../apps/web/src/hooks/useBoard", () => ({
  useCreateBoardMaintainer: () => ({ mutateAsync: createMutateAsync, isPending: false }),
  useUpdateBoardMaintainer: () => ({ mutateAsync: updateMutateAsync, isPending: false }),
}));

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    agents: { list: (...args: unknown[]) => agentsList(...args) },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(BoardMaintainerDialog, {
        boardId: "board-1",
        maintainer: {
          id: "maintainer-1",
          agent_id: "agent-1",
          interval_seconds: 3600,
          heartbeat_enabled: false,
        },
        open: true,
        onOpenChange: vi.fn(),
      }),
    ),
  );
}

describe("BoardMaintainerDialog", () => {
  beforeEach(() => {
    createMutateAsync.mockReset();
    updateMutateAsync.mockReset();
    agentsList.mockReset();
    agentsList.mockResolvedValue([{ id: "agent-1", name: "Maintainer Agent" }]);
  });

  it("submits scheduled heartbeat toggle with maintainer update", async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Interval seconds"), { target: { value: "3600" } });
    expect(await screen.findByRole("switch", { name: "Scheduled heartbeat" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(updateMutateAsync).toHaveBeenCalledWith({
        maintainerId: "maintainer-1",
        body: {
          interval_seconds: 3600,
          heartbeat_enabled: false,
        },
      });
    });
  });
});
