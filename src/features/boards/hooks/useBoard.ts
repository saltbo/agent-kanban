import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "@/lib/api";

const LAST_BOARD_KEY = "ak-last-board";

/** Remember last visited board for redirect from "/" */
export function getLastBoardId(): string | null {
  return localStorage.getItem(LAST_BOARD_KEY);
}

export function setLastBoardId(id: string) {
  localStorage.setItem(LAST_BOARD_KEY, id);
}

export function clearLastBoardId(id: string) {
  if (localStorage.getItem(LAST_BOARD_KEY) === id) localStorage.removeItem(LAST_BOARD_KEY);
}

/** Fetch a single board by ID (from URL params) */
export function useBoard(boardId: string | undefined) {
  const {
    data: board = null,
    isLoading: loading,
    error: rawError,
    refetch,
  } = useQuery({
    queryKey: ["board", boardId],
    queryFn: () => api.boards.get(boardId!),
    enabled: !!boardId,
    refetchInterval: 30_000,
    retry: 2,
  });

  useEffect(() => {
    if (boardId && board) setLastBoardId(boardId);
  }, [boardId, board]);

  const error = rawError ? ((rawError as any).message === "NOT_AUTHENTICATED" ? "NOT_AUTHENTICATED" : "Can't reach server") : null;

  return { board, loading, error, refresh: refetch };
}

/** Fetch the list of all boards (for switcher, redirect) */
export function useBoards() {
  const {
    data: boards = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["boards"],
    queryFn: () => api.boards.list(),
  });

  return { boards, loading, refresh: refetch };
}

export function useCreateBoard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; type: "dev" | "ops"; description?: string }) => api.boards.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}

export function useUpdateBoard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; description?: string; visibility?: "private" | "public"; labels?: any[] }) =>
      api.boards.update(id, body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
      if (data?.id) queryClient.invalidateQueries({ queryKey: ["board", data.id] });
    },
  });
}

export function useCreateBoardLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ boardId, ...body }: { boardId: string; name: string; color: string; description?: string }) =>
      api.boards.createLabel(boardId, body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
      if (data?.id) queryClient.invalidateQueries({ queryKey: ["board", data.id] });
    },
  });
}

export function useUpdateBoardLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ boardId, name, ...body }: { boardId: string; name: string; nextName?: string; color?: string; description?: string }) =>
      api.boards.updateLabel(boardId, name, { name: body.nextName, color: body.color, description: body.description }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
      if (data?.id) queryClient.invalidateQueries({ queryKey: ["board", data.id] });
    },
  });
}

export function useDeleteBoardLabel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ boardId, name }: { boardId: string; name: string }) => api.boards.deleteLabel(boardId, name),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
      if (data?.id) queryClient.invalidateQueries({ queryKey: ["board", data.id] });
    },
  });
}

export function useDeleteBoard() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.boards.delete(id),
    onSuccess: (_data, id) => {
      clearLastBoardId(id);
      queryClient.setQueryData<any[]>(["boards"], (boards) => boards?.filter((board) => board.id !== id) ?? []);
      queryClient.removeQueries({ queryKey: ["board", id] });
      queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}
