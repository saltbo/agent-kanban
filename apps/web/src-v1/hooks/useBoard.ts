import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";

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

export function useBoardMaintainers(boardId: string | undefined) {
  const {
    data: maintainers = [],
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["board-maintainers", boardId],
    queryFn: () => api.boards.maintainers(boardId!),
    enabled: !!boardId,
    refetchInterval: 30_000,
  });

  return { maintainers, loading, refresh: refetch };
}

export function useBoardMaintainer(boardId: string | undefined, maintainerId: string | undefined) {
  const {
    data: maintainer = null,
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["board-maintainer", boardId, maintainerId],
    queryFn: () => api.boards.getMaintainer(boardId!, maintainerId!),
    enabled: !!boardId && !!maintainerId,
    refetchInterval: 30_000,
  });

  return { maintainer, loading, refresh: refetch };
}

export function useBoardMaintainerRuns(boardId: string | undefined, maintainerId: string | undefined) {
  const {
    data = { data: [], pagination: { limit: 100, hasMore: false } },
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["board-maintainer-runs", boardId, maintainerId],
    queryFn: () => api.boards.maintainerRuns(boardId!, maintainerId!, 100),
    enabled: !!boardId && !!maintainerId,
    refetchInterval: 30_000,
  });

  return { runs: data.data, pagination: data.pagination, loading, refresh: refetch };
}

export function useBoardMaintainerSessions(maintainerId: string | undefined) {
  const {
    data = { data: [], pagination: { limit: 100, hasMore: false } },
    isLoading: loading,
    refetch,
  } = useQuery({
    queryKey: ["board-maintainer-sessions", maintainerId],
    queryFn: () => api.sessions.list({ labelSelector: `maintainerId=${maintainerId}`, limit: 100 }),
    enabled: !!maintainerId,
    refetchInterval: 30_000,
  });

  return { sessions: data.data, pagination: data.pagination, loading, refresh: refetch };
}

export function useBoardMaintainerMemories(boardId: string | undefined, maintainerId: string | undefined) {
  const {
    data = { data: [], pagination: { limit: 100, hasMore: false } },
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["board-maintainer-memories", boardId, maintainerId],
    queryFn: () => api.boards.maintainerMemories(boardId!, maintainerId!, 100),
    enabled: !!boardId && !!maintainerId,
  });

  return { memories: data.data, pagination: data.pagination, loading, error, refresh: refetch };
}

export function useBoardMaintainerVariables(boardId: string | undefined, maintainerId: string | undefined) {
  const {
    data = { data: [], credential_id: null, updated_at: null },
    isLoading: loading,
    refetch,
    error,
  } = useQuery({
    queryKey: ["board-maintainer-variables", boardId, maintainerId],
    queryFn: () => api.boards.maintainerVariables(boardId!, maintainerId!),
    enabled: !!boardId && !!maintainerId,
  });

  return { variables: data.data, credentialId: data.credential_id, updatedAt: data.updated_at, loading, error, refresh: refetch };
}

export function useCreateBoardMaintainer(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.boards.createMaintainer(boardId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board-maintainers", boardId] });
    },
  });
}

export function useUpdateBoardMaintainer(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ maintainerId, body }: { maintainerId: string; body: Record<string, unknown> }) =>
      api.boards.updateMaintainer(boardId, maintainerId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board-maintainers", boardId] });
    },
  });
}

export function useDeleteBoardMaintainer(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (maintainerId: string) => api.boards.deleteMaintainer(boardId, maintainerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board-maintainers", boardId] });
    },
  });
}

export function useUpdateBoardMaintainerVariables(boardId: string | undefined, maintainerId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: Record<string, string>) => api.boards.updateMaintainerVariables(boardId!, maintainerId!, { variables }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["board-maintainer-variables", boardId, maintainerId] });
      queryClient.invalidateQueries({ queryKey: ["board-maintainer-sessions", maintainerId] });
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
