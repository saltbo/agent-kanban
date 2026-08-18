import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskFormDialog } from "../apps/web/src/components/TaskFormDialog";

const tasksCreate = vi.fn();
const tasksUpdate = vi.fn();
const tasksAssign = vi.fn();
const repositoriesList = vi.fn();
const agentsList = vi.fn();

vi.mock("../apps/web/src/lib/api", () => ({
  api: {
    tasks: {
      create: (...args: unknown[]) => tasksCreate(...args),
      update: (...args: unknown[]) => tasksUpdate(...args),
      assign: (...args: unknown[]) => tasksAssign(...args),
    },
    repositories: { list: (...args: unknown[]) => repositoriesList(...args) },
    agents: { list: (...args: unknown[]) => agentsList(...args) },
  },
}));

const LABELS = [
  { name: "bug", color: "#ff0000", description: "Bug" },
  { name: "feature", color: "#00ff00", description: "Feature" },
];

function renderDialog(props: Partial<React.ComponentProps<typeof TaskFormDialog>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TaskFormDialog, {
        mode: "create",
        open: true,
        boardId: "board-1",
        labels: LABELS,
        onClose,
        onSaved,
        ...props,
      }),
    ),
  );
  return { onClose, onSaved };
}

// The dialog renders two Base UI selects: [Repository, Assign to]. Base UI
// commits an item on click only while it is highlighted; mousemove sets the
// active index (same as a real pointer hover).
async function chooseOption(triggerIndex: number, optionName: string) {
  fireEvent.click(screen.getAllByRole("combobox")[triggerIndex]);
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.mouseMove(option);
  fireEvent.click(option);
  await waitFor(() => expect(screen.queryByRole("option", { name: optionName })).not.toBeInTheDocument());
}

describe("TaskFormDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositoriesList.mockResolvedValue([{ id: "repo-1", name: "Repo One" }]);
    agentsList.mockResolvedValue([
      { id: "agent-1", name: "Worker One", username: "worker-one", kind: "worker" },
      { id: "leader-1", name: "Lead", username: "lead", kind: "leader" },
    ]);
    tasksCreate.mockResolvedValue({});
    tasksUpdate.mockResolvedValue({});
    tasksAssign.mockResolvedValue({});
  });

  describe("create mode", () => {
    it("submits title, repository, assignee, and labels", async () => {
      const { onClose, onSaved } = renderDialog();

      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Fix the thing" } });
      await chooseOption(0, "Repo One");
      await chooseOption(1, "Worker One");
      fireEvent.click(screen.getByRole("button", { name: "bug" }));
      fireEvent.click(screen.getByRole("button", { name: "Create task" }));

      await waitFor(() =>
        expect(tasksCreate).toHaveBeenCalledWith({
          board_id: "board-1",
          title: "Fix the thing",
          repository_id: "repo-1",
          assigned_to: "agent-1",
          labels: ["bug"],
        }),
      );
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("keeps submit disabled while the title is empty", async () => {
      renderDialog();

      const submit = await screen.findByRole("button", { name: "Create task" });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(tasksCreate).not.toHaveBeenCalled();

      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Now it can submit" } });
      expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
    });
  });

  describe("boardType", () => {
    it("disables submit and shows the hint on a dev board with no repository selected", async () => {
      renderDialog({ boardType: "dev" });

      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Dev task" } });

      expect(screen.getByText("Dev board tasks require a repository")).toBeInTheDocument();
      const submit = screen.getByRole("button", { name: "Create task" });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(tasksCreate).not.toHaveBeenCalled();
    });

    it("enables submit and posts repository_id on a dev board once a repository is selected", async () => {
      renderDialog({ boardType: "dev" });

      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Dev task" } });
      await chooseOption(0, "Repo One");

      expect(screen.queryByText("Dev board tasks require a repository")).not.toBeInTheDocument();
      const submit = screen.getByRole("button", { name: "Create task" });
      expect(submit).toBeEnabled();
      fireEvent.click(submit);

      await waitFor(() =>
        expect(tasksCreate).toHaveBeenCalledWith({
          board_id: "board-1",
          title: "Dev task",
          repository_id: "repo-1",
        }),
      );
    });

    it("hides the repository field and omits repository_id on an ops board", async () => {
      renderDialog({ boardType: "ops" });

      fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Ops task" } });

      expect(screen.queryByText("Repository")).not.toBeInTheDocument();
      // Only the assign select is rendered.
      expect(screen.getAllByRole("combobox")).toHaveLength(1);

      fireEvent.click(screen.getByRole("button", { name: "Create task" }));

      await waitFor(() => expect(tasksCreate).toHaveBeenCalledTimes(1));
      const body = tasksCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(body).toEqual({ board_id: "board-1", title: "Ops task" });
      expect(body).not.toHaveProperty("repository_id");
    });
  });

  describe("edit mode", () => {
    const initialTask = {
      id: "task-1",
      title: "Old title",
      description: "Keep me",
      repository_id: "repo-1",
      labels: ["bug"],
      assigned_to: null,
      status: "todo",
    };

    it("patches only the changed fields", async () => {
      renderDialog({ mode: "edit", initialTask });

      const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
      expect(titleInput).toHaveValue("Old title");
      fireEvent.change(titleInput, { target: { value: "New title" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(tasksUpdate).toHaveBeenCalledTimes(1));
      expect(tasksUpdate).toHaveBeenCalledWith("task-1", { title: "New title" });
      expect(tasksAssign).not.toHaveBeenCalled();
    });

    it("does not call update when nothing changed", async () => {
      const { onClose, onSaved } = renderDialog({ mode: "edit", initialTask });

      fireEvent.click(await screen.findByRole("button", { name: "Save" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(tasksUpdate).not.toHaveBeenCalled();
      expect(tasksAssign).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("assigns a todo + unassigned task when an assignee is picked", async () => {
      renderDialog({
        mode: "edit",
        initialTask: {
          id: "task-1",
          title: "Same title",
          description: null,
          repository_id: null,
          labels: [],
          assigned_to: null,
          status: "todo",
        },
      });

      await chooseOption(1, "Worker One");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(tasksAssign).toHaveBeenCalledTimes(1));
      expect(tasksAssign).toHaveBeenCalledWith("task-1", "agent-1");
      expect(tasksUpdate).not.toHaveBeenCalled();
    });

    it("omits repository_id from the patch on an ops board", async () => {
      renderDialog({
        mode: "edit",
        boardType: "ops",
        initialTask: {
          id: "task-1",
          title: "Old title",
          description: "Keep me",
          repository_id: null,
          labels: [],
          assigned_to: null,
          status: "todo",
        },
      });

      // The repository select is not rendered at all on ops boards.
      expect(screen.queryByText("Repository")).not.toBeInTheDocument();

      const titleInput = (await screen.findByLabelText("Title")) as HTMLInputElement;
      fireEvent.change(titleInput, { target: { value: "New title" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(tasksUpdate).toHaveBeenCalledTimes(1));
      const [, body] = tasksUpdate.mock.calls[0] as [string, Record<string, unknown>];
      expect(body).toEqual({ title: "New title" });
      expect(body).not.toHaveProperty("repository_id");
    });

    it("renders the assignee read-only for in-progress tasks", async () => {
      renderDialog({
        mode: "edit",
        initialTask: {
          id: "task-2",
          title: "Busy task",
          description: null,
          repository_id: null,
          labels: [],
          assigned_to: "agent-1",
          status: "in_progress",
        },
      });

      // Only the repository select is rendered; the assign select is not.
      await screen.findByLabelText("Title");
      expect(screen.getAllByRole("combobox")).toHaveLength(1);
      // The assignee resolves to the agent name once the agents query lands.
      expect(await screen.findByText("Worker One")).toBeInTheDocument();
    });
  });
});
