// @vitest-environment node

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, seedUser, setupMiniflare } from "./helpers/db";

const env = createTestEnv();
let mf: Miniflare;

beforeAll(async () => {
  ({ mf, db: env.DB } = await setupMiniflare());
  await seedUser(env.DB, "board-test-user", "board@test.com");
  await seedUser(env.DB, "board-test-user-2", "board2@test.com");
});

afterAll(async () => {
  await mf.dispose();
});

describe("boardRepo", () => {
  it("createBoard creates a board with default description", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "My Board", "dev");
    expect(board.name).toBe("My Board");
    expect(board.owner_id).toBe("board-test-user");
    expect(board.id).toBeDefined();
  });

  it("createBoard creates a board with custom description", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "Described Board", "dev", "A description");
    expect(board.description).toBe("A description");
  });

  it("listBoards returns boards for a specific owner", async () => {
    const { listBoards, createBoard } = await import("../apps/web/server/boardRepo");
    await createBoard(env.DB, "board-test-user-2", "User2 Board", "dev");
    const boards = await listBoards(env.DB, "board-test-user-2");
    expect(boards.length).toBeGreaterThanOrEqual(1);
    expect(boards.every((b: any) => b.owner_id === "board-test-user-2")).toBe(true);
  });

  it("getBoardByName returns a board by name", async () => {
    const { getBoardByName } = await import("../apps/web/server/boardRepo");
    const board = await getBoardByName(env.DB, "board-test-user", "My Board");
    expect(board).not.toBeNull();
    expect(board!.name).toBe("My Board");
  });

  it("getBoardByName returns null for unknown name", async () => {
    const { getBoardByName } = await import("../apps/web/server/boardRepo");
    const board = await getBoardByName(env.DB, "board-test-user", "Nonexistent Board");
    expect(board).toBeNull();
  });

  it("getBoard returns board with tasks array", async () => {
    const { createBoard, getBoard } = await import("../apps/web/server/boardRepo");
    const created = await createBoard(env.DB, "board-test-user", "Get Board", "dev");
    const board = await getBoard(env.DB, created.id, "board-test-user");
    expect(board).not.toBeNull();
    expect(board!.id).toBe(created.id);
    expect(Array.isArray(board!.tasks)).toBe(true);
  });

  it("getBoard returns null for unknown id", async () => {
    const { getBoard } = await import("../apps/web/server/boardRepo");
    const board = await getBoard(env.DB, "nonexistent", "board-test-user");
    expect(board).toBeNull();
  });

  it("getBoard includes blocked status on tasks", async () => {
    const { createBoard, getBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, "board-test-user", "Blocked Board", "ops");
    const taskA = await createTask(env.DB, "board-test-user", { title: "Task A", board_id: board.id });
    await createTask(env.DB, "board-test-user", { title: "Task B", board_id: board.id, depends_on: [taskA.id] });
    const result = await getBoard(env.DB, board.id, "board-test-user");
    const taskB = result!.tasks.find((t: any) => t.title === "Task B");
    expect(taskB!.blocked).toBe(true);
  });

  it("records board repository mappings from dev tasks", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { listBoardRepositories } = await import("../apps/web/server/boardRepositoryRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const { createTask, updateTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, "board-test-user", "Repo Mapping Board", "dev");
    const repoA = await createRepository(env.DB, "board-test-user", {
      name: "repo-mapping-a",
      url: "https://github.com/board-test/repo-mapping-a",
    });
    const repoB = await createRepository(env.DB, "board-test-user", {
      name: "repo-mapping-b",
      url: "https://github.com/board-test/repo-mapping-b",
    });

    const task = await createTask(env.DB, "board-test-user", { title: "Repo task", board_id: board.id, repository_id: repoA.id });
    await updateTask(env.DB, task.id, { repository_id: repoB.id });

    const repos = await listBoardRepositories(env.DB, "board-test-user", board.id);
    expect(repos.map((repo) => repo.id).sort()).toEqual([repoA.id, repoB.id].sort());
  });

  it("rejects task repository mappings across owners", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createRepository } = await import("../apps/web/server/repositoryRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const board = await createBoard(env.DB, "board-test-user", "Cross Owner Repo Board", "dev");
    const otherRepo = await createRepository(env.DB, "board-test-user-2", {
      name: "cross-owner-repo",
      url: "https://github.com/other-owner/cross-owner-repo",
    });

    await expect(createTask(env.DB, "board-test-user", { title: "Bad repo", board_id: board.id, repository_id: otherRepo.id })).rejects.toThrow(
      "Repository not found",
    );
  });

  it("rejects task creation on boards owned by another owner", async () => {
    const { createBoard } = await import("../apps/web/server/boardRepo");
    const { createTask } = await import("../apps/web/server/taskRepo");
    const otherBoard = await createBoard(env.DB, "board-test-user-2", "Cross Owner Board", "ops");

    await expect(createTask(env.DB, "board-test-user", { title: "Bad board", board_id: otherBoard.id })).rejects.toThrow("Board not found");
  });

  it("getDefaultBoard returns the first board for a user", async () => {
    const { getDefaultBoard } = await import("../apps/web/server/boardRepo");
    const board = await getDefaultBoard(env.DB, "board-test-user");
    expect(board).not.toBeNull();
    expect(board!.owner_id).toBe("board-test-user");
  });

  it("getDefaultBoard returns null for user with no boards", async () => {
    const { getDefaultBoard } = await import("../apps/web/server/boardRepo");
    const board = await getDefaultBoard(env.DB, "no-boards-user");
    expect(board).toBeNull();
  });

  it("updateBoard updates name only", async () => {
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "Update Name Board", "dev");
    const updated = await updateBoard(env.DB, board.id, "board-test-user", { name: "New Name" });
    expect(updated!.name).toBe("New Name");
  });

  it("updateBoard updates description only", async () => {
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "Update Desc Board", "dev");
    const updated = await updateBoard(env.DB, board.id, "board-test-user", { description: "New Desc" });
    expect(updated!.description).toBe("New Desc");
  });

  it("updateBoard updates both name and description", async () => {
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "Update Both Board", "dev");
    const updated = await updateBoard(env.DB, board.id, "board-test-user", { name: "Both Name", description: "Both Desc" });
    expect(updated!.name).toBe("Both Name");
    expect(updated!.description).toBe("Both Desc");
  });

  it("updateBoard with empty update returns board unchanged", async () => {
    const { createBoard, updateBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "No Update Board", "dev");
    const updated = await updateBoard(env.DB, board.id, "board-test-user", {});
    expect(updated!.name).toBe("No Update Board");
  });

  it("updateBoard returns null for unknown board", async () => {
    const { updateBoard } = await import("../apps/web/server/boardRepo");
    const updated = await updateBoard(env.DB, "nonexistent", "board-test-user", { name: "X" });
    expect(updated).toBeNull();
  });

  it("deleteBoard removes a board", async () => {
    const { createBoard, deleteBoard, getBoard } = await import("../apps/web/server/boardRepo");
    const board = await createBoard(env.DB, "board-test-user", "Delete Board", "dev");
    const deleted = await deleteBoard(env.DB, board.id, "board-test-user");
    expect(deleted).toBe(true);
    const found = await getBoard(env.DB, board.id, "board-test-user");
    expect(found).toBeNull();
  });

  it("deleteBoard returns false for unknown board", async () => {
    const { deleteBoard } = await import("../apps/web/server/boardRepo");
    const deleted = await deleteBoard(env.DB, "nonexistent", "board-test-user");
    expect(deleted).toBe(false);
  });
});
